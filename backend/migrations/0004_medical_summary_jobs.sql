-- Forward only; no backfill, external extension, existing privilege change or OCR write.
ALTER TABLE public.extracted_medical_text ADD CONSTRAINT extraction_summary_identity UNIQUE(id,document_id,patient_id);
CREATE FUNCTION public.summary_digest(body TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT
SET search_path=pg_catalog,public AS $$ SELECT encode(sha256(convert_to(body,'UTF8')),'hex') $$;
CREATE FUNCTION public.summary_extraction_fingerprint(e UUID,body TEXT,meta JSONB,version TEXT,attempt INTEGER,token UUID)
RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public AS $$
 SELECT public.summary_digest(jsonb_build_array(e,body,meta,version,attempt,token)::text)
$$;
CREATE TABLE public.summary_source_snapshots (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL, patient_id UUID NOT NULL,
 extraction_id UUID NOT NULL, processing_attempt INTEGER NOT NULL CHECK(processing_attempt BETWEEN 1 AND 5),
 processing_claim_token UUID NOT NULL, extracted_text TEXT NOT NULL CHECK(octet_length(extracted_text) BETWEEN 1 AND 32768),
 source_metadata JSONB NOT NULL, extractor_version TEXT NOT NULL,
 source_fingerprint TEXT NOT NULL CHECK(source_fingerprint ~ '^[0-9a-f]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,document_id,patient_id), UNIQUE(extraction_id,processing_attempt,processing_claim_token,source_fingerprint),
 FOREIGN KEY(document_id,patient_id) REFERENCES public.medical_documents(id,patient_id),
 FOREIGN KEY(extraction_id,document_id,patient_id) REFERENCES public.extracted_medical_text(id,document_id,patient_id),
 CHECK(public.valid_extraction_payload(extracted_text,source_metadata,extractor_version) IS TRUE),
 CHECK(source_fingerprint=public.summary_extraction_fingerprint(extraction_id,extracted_text,source_metadata,extractor_version,processing_attempt,processing_claim_token))
);
CREATE INDEX summary_snapshot_owner_idx ON public.summary_source_snapshots(document_id,patient_id);
CREATE INDEX summary_snapshot_extraction_idx ON public.summary_source_snapshots(extraction_id,document_id,patient_id);
CREATE INDEX summary_snapshot_patient_idx ON public.summary_source_snapshots(patient_id,id);

CREATE FUNCTION public.summary_source_current(s public.summary_source_snapshots) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT EXISTS(SELECT 1 FROM public.document_processing_jobs j
 JOIN public.extracted_medical_text e ON (e.document_id,e.patient_id)=(j.document_id,j.patient_id)
 JOIN public.medical_documents d ON (d.id,d.patient_id)=(j.document_id,j.patient_id)
 WHERE (j.document_id,j.patient_id)=(s.document_id,s.patient_id) AND j.state='completed'
 AND d.processing_status='completed' AND e.processing_status='completed'
 AND e.id=s.extraction_id AND e.processing_attempt=s.processing_attempt AND j.attempt_count=s.processing_attempt
 AND e.processing_claim_token=s.processing_claim_token
 AND public.summary_extraction_fingerprint(e.id,e.extracted_text,e.source_metadata,e.extractor_version,e.processing_attempt,e.processing_claim_token)=s.source_fingerprint)
$$;
-- Match the existing OCR lock order: OCR job -> extraction -> document. These
-- shared row locks prevent a source replacement until snapshot/publication commits.
CREATE FUNCTION public.lock_summary_source(s public.summary_source_snapshots) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 PERFORM 1 FROM public.document_processing_jobs WHERE (document_id,patient_id)=(s.document_id,s.patient_id) FOR SHARE;
 PERFORM 1 FROM public.extracted_medical_text WHERE id=s.extraction_id AND (document_id,patient_id)=(s.document_id,s.patient_id) FOR SHARE;
 PERFORM 1 FROM public.medical_documents WHERE (id,patient_id)=(s.document_id,s.patient_id) FOR SHARE;
 RETURN public.summary_source_current(s);
END $$;
CREATE FUNCTION public.guard_summary_snapshot() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_IMMUTABLE'; END IF;
 IF public.lock_summary_source(NEW) IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_SOURCE_INELIGIBLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER summary_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON public.summary_source_snapshots
 FOR EACH ROW EXECUTE FUNCTION public.guard_summary_snapshot();

CREATE TABLE public.medical_summary_jobs (
 id UUID PRIMARY KEY, snapshot_id UUID NOT NULL, document_id UUID NOT NULL, patient_id UUID NOT NULL,
 pipeline_config JSONB NOT NULL CHECK(jsonb_typeof(pipeline_config)='object' AND octet_length(pipeline_config::text)<=2048),
 pipeline_fingerprint TEXT NOT NULL CHECK(pipeline_fingerprint=public.summary_digest(pipeline_config::text)),
 catalogue_sha256 TEXT NOT NULL CHECK(catalogue_sha256 ~ '^[0-9a-f]{64}$'),
 canonical_input TEXT NOT NULL CHECK(octet_length(canonical_input)<=262144),
 input_sha256 TEXT NOT NULL CHECK(input_sha256=public.summary_digest(canonical_input)),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','retry_wait','completed','failed','cancelled','superseded')),
 attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 3),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, lease_token UUID, lease_expires_at TIMESTAMPTZ, attempt_deadline_at TIMESTAMPTZ,
 completion_token UUID,
 last_error_code TEXT CHECK(last_error_code IN ('MODEL_FAILED','MODEL_TIMEOUT','INVALID_SUMMARY','LEASE_EXPIRED','CANCELLED','SOURCE_SUPERSEDED')),
 UNIQUE(snapshot_id,pipeline_fingerprint), UNIQUE(id,snapshot_id,document_id,patient_id),
 FOREIGN KEY(snapshot_id,document_id,patient_id) REFERENCES public.summary_source_snapshots(id,document_id,patient_id),
 CHECK(attempt_count BETWEEN 0 AND max_attempts),
 CHECK((state='running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND attempt_deadline_at IS NOT NULL
  AND started_at IS NOT NULL AND attempt_count>0 AND finished_at IS NULL AND lease_expires_at<=attempt_deadline_at)
  OR (state<>'running' AND lease_token IS NULL AND lease_expires_at IS NULL AND attempt_deadline_at IS NULL)),
 CHECK((state='pending' AND attempt_count=0 AND started_at IS NULL AND finished_at IS NULL AND last_error_code IS NULL)
  OR state='running' OR (state='retry_wait' AND attempt_count>0 AND attempt_count<max_attempts AND finished_at IS NOT NULL AND last_error_code IS NOT NULL)
  OR (state IN ('failed','cancelled','superseded') AND finished_at IS NOT NULL AND last_error_code IS NOT NULL)
  OR (state='completed' AND finished_at IS NOT NULL AND attempt_count>0 AND last_error_code IS NULL)),
 CHECK((state='completed')=(completion_token IS NOT NULL))
);
CREATE INDEX summary_job_snapshot_owner_idx ON public.medical_summary_jobs(snapshot_id,document_id,patient_id);
CREATE INDEX summary_job_patient_idx ON public.medical_summary_jobs(patient_id,id);
CREATE INDEX summary_job_ready_idx ON public.medical_summary_jobs(patient_id,next_attempt_at,created_at,id) WHERE state IN ('pending','retry_wait');
CREATE INDEX summary_job_expired_idx ON public.medical_summary_jobs(patient_id,lease_expires_at,id) WHERE state='running';
-- Stage 3A.3 admission is exactly one globally, including concurrent instances.
CREATE UNIQUE INDEX summary_single_running ON public.medical_summary_jobs((true)) WHERE state='running';

ALTER TABLE public.ai_report_summaries
 ADD COLUMN summary_contract_version INTEGER,
 ADD COLUMN source_snapshot_id UUID,
 ADD COLUMN summary_job_id UUID,
 ADD COLUMN source_fingerprint TEXT,
 ADD COLUMN pipeline_fingerprint TEXT,
 ADD COLUMN input_sha256 TEXT,
 ADD COLUMN structured_output JSONB,
 ADD COLUMN provenance JSONB,
 ADD COLUMN accepted_attempt INTEGER,
 ADD COLUMN publication_token UUID,
 ADD CONSTRAINT summary_job_owner FOREIGN KEY(summary_job_id,source_snapshot_id,document_id,patient_id)
   REFERENCES public.medical_summary_jobs(id,snapshot_id,document_id,patient_id),
 ADD CONSTRAINT summary_v1_shape CHECK((
  (summary_contract_version IS NULL AND source_snapshot_id IS NULL AND summary_job_id IS NULL AND source_fingerprint IS NULL
   AND pipeline_fingerprint IS NULL AND input_sha256 IS NULL AND structured_output IS NULL AND provenance IS NULL AND accepted_attempt IS NULL AND publication_token IS NULL)
  OR (summary_contract_version=1 AND source_snapshot_id IS NOT NULL AND summary_job_id IS NOT NULL AND source_fingerprint ~ '^[0-9a-f]{64}$'
   AND pipeline_fingerprint ~ '^[0-9a-f]{64}$' AND input_sha256 ~ '^[0-9a-f]{64}$' AND structured_output IS NOT NULL AND provenance IS NOT NULL
   AND accepted_attempt BETWEEN 1 AND 3 AND publication_token IS NOT NULL AND processing_status='completed'
   AND octet_length(structured_output::text)<=262144 AND octet_length(summary_text)<=32768)) IS TRUE);
CREATE UNIQUE INDEX summary_one_job_publication ON public.ai_report_summaries(summary_job_id);
CREATE UNIQUE INDEX summary_one_source_pipeline ON public.ai_report_summaries(source_snapshot_id,pipeline_fingerprint) WHERE summary_contract_version=1;
CREATE INDEX summary_publication_job_owner_idx ON public.ai_report_summaries(summary_job_id,source_snapshot_id,document_id,patient_id);

CREATE FUNCTION public.guard_summary_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE s public.summary_source_snapshots; input JSONB;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_IMMUTABLE'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'pending' OR NEW.attempt_count<>0 THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_INVALID_TRANSITION'; END IF;
  SELECT * INTO s FROM public.summary_source_snapshots WHERE id=NEW.snapshot_id AND document_id=NEW.document_id AND patient_id=NEW.patient_id;
  IF NOT FOUND OR public.lock_summary_source(s) IS NOT TRUE THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_SOURCE_INELIGIBLE'; END IF;
  input:=NEW.canonical_input::jsonb;
  IF input#>>'{scope,request_id}' IS DISTINCT FROM NEW.id::text OR input#>>'{scope,source_ref}' IS DISTINCT FROM NEW.snapshot_id::text
   OR input#>>'{source,text}' IS DISTINCT FROM s.extracted_text OR input#>>'{source,original_sha256}' IS DISTINCT FROM s.source_metadata#>>'{source,sha256}'
   OR input#>>'{source,processing_attempt}' IS DISTINCT FROM s.processing_attempt::text THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_INPUT_MISMATCH'; END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','attempt_count','next_attempt_at','started_at','finished_at','lease_token','lease_expires_at','attempt_deadline_at','completion_token','last_error_code'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','attempt_count','next_attempt_at','started_at','finished_at','lease_token','lease_expires_at','attempt_deadline_at','completion_token','last_error_code'])
    OR OLD.state IN ('completed','failed','cancelled','superseded') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_IMMUTABLE'; END IF;
  IF NOT ((OLD.state IN ('pending','retry_wait') AND NEW.state IN ('running','cancelled','superseded'))
    OR (OLD.state='running' AND NEW.state IN ('running','completed','retry_wait','failed','cancelled','superseded'))) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_INVALID_TRANSITION'; END IF;
  IF NOT(NEW.state='running' AND OLD.state<>'running') AND NEW.attempt_count<>OLD.attempt_count THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_INVALID_TRANSITION'; END IF;
  IF NEW.state='running' AND OLD.state='running' AND (NEW.lease_token IS DISTINCT FROM OLD.lease_token
   OR NEW.attempt_deadline_at IS DISTINCT FROM OLD.attempt_deadline_at OR NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_INVALID_TRANSITION'; END IF;
  IF NEW.state='running' AND OLD.state<>'running' AND (OLD.state NOT IN ('pending','retry_wait') OR NEW.attempt_count<>OLD.attempt_count+1 OR NEW.next_attempt_at>clock_timestamp()) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_INVALID_TRANSITION'; END IF;
  IF NEW.state='completed' AND (OLD.state<>'running' OR OLD.lease_expires_at<=clock_timestamp() OR OLD.attempt_deadline_at<=clock_timestamp()
   OR NEW.completion_token IS DISTINCT FROM OLD.lease_token OR NOT EXISTS(SELECT 1 FROM public.ai_report_summaries a WHERE a.summary_job_id=OLD.id
    AND a.patient_id=OLD.patient_id AND a.accepted_attempt=OLD.attempt_count AND a.publication_token=OLD.lease_token)) THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_LEASE_LOST'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER summary_job_guard BEFORE INSERT OR UPDATE OR DELETE ON public.medical_summary_jobs
 FOR EACH ROW EXECUTE FUNCTION public.guard_summary_job();

CREATE FUNCTION public.guard_summary_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE j public.medical_summary_jobs; s public.summary_source_snapshots;
BEGIN
 IF TG_OP<>'INSERT' THEN
  IF OLD.summary_contract_version IS NOT NULL OR NEW.summary_contract_version IS NOT NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_IMMUTABLE'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF NEW.summary_contract_version IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO j FROM public.medical_summary_jobs WHERE id=NEW.summary_job_id AND document_id=NEW.document_id AND patient_id=NEW.patient_id FOR UPDATE;
 IF NOT FOUND OR j.state<>'running' OR j.lease_token IS DISTINCT FROM NEW.publication_token OR j.attempt_count<>NEW.accepted_attempt
  OR j.lease_expires_at<=clock_timestamp() OR j.attempt_deadline_at<=clock_timestamp() THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_LEASE_LOST'; END IF;
 SELECT * INTO s FROM public.summary_source_snapshots WHERE id=j.snapshot_id;
 IF public.lock_summary_source(s) IS NOT TRUE OR NEW.source_snapshot_id IS DISTINCT FROM s.id OR NEW.source_fingerprint IS DISTINCT FROM s.source_fingerprint
  OR NEW.pipeline_fingerprint IS DISTINCT FROM j.pipeline_fingerprint OR NEW.input_sha256 IS DISTINCT FROM j.input_sha256
  OR NEW.structured_output->'provenance' IS DISTINCT FROM NEW.provenance OR NEW.provenance->>'input_sha256' IS DISTINCT FROM j.input_sha256
  OR NEW.structured_output->'scope' IS DISTINCT FROM j.canonical_input::jsonb->'scope'
  OR NEW.structured_output->>'kind' IS DISTINCT FROM 'medical-summary-output' OR NEW.structured_output->>'schema_version' IS DISTINCT FROM '1'
  OR (NEW.provenance-'input_sha256') IS DISTINCT FROM j.pipeline_config THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_SOURCE_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER summary_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON public.ai_report_summaries
 FOR EACH ROW EXECUTE FUNCTION public.guard_summary_publication();
-- Do not allow a standalone accepted row to commit without atomic job completion.
CREATE FUNCTION public.confirm_summary_publication() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.summary_contract_version=1 AND NOT EXISTS(SELECT 1 FROM public.medical_summary_jobs j WHERE j.id=NEW.summary_job_id
  AND j.patient_id=NEW.patient_id AND j.state='completed' AND j.completion_token=NEW.publication_token AND j.attempt_count=NEW.accepted_attempt) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_ATOMIC_COMPLETION_REQUIRED'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER summary_atomic_publication AFTER INSERT ON public.ai_report_summaries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.confirm_summary_publication();

REVOKE ALL ON public.summary_source_snapshots,public.medical_summary_jobs FROM PUBLIC;
GRANT SELECT,INSERT ON public.summary_source_snapshots TO health_wallet_app;
GRANT SELECT,INSERT,UPDATE ON public.medical_summary_jobs TO health_wallet_app;
REVOKE ALL ON FUNCTION public.summary_digest(TEXT),public.summary_extraction_fingerprint(UUID,TEXT,JSONB,TEXT,INTEGER,UUID),
 public.summary_source_current(public.summary_source_snapshots),public.lock_summary_source(public.summary_source_snapshots),
 public.guard_summary_snapshot(),public.guard_summary_job(),public.guard_summary_publication(),public.confirm_summary_publication() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.summary_digest(TEXT),public.summary_extraction_fingerprint(UUID,TEXT,JSONB,TEXT,INTEGER,UUID),
 public.summary_source_current(public.summary_source_snapshots),public.lock_summary_source(public.summary_source_snapshots),
 public.guard_summary_snapshot(),public.guard_summary_job(),public.guard_summary_publication(),public.confirm_summary_publication() TO health_wallet_app;
