-- Phase 4: extraction readiness, safe owner retry, and source-bound history manifests.
CREATE OR REPLACE FUNCTION public.summary_source_current(s public.summary_source_snapshots) RETURNS BOOLEAN
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.document_processing_jobs j
 JOIN public.extracted_medical_text e ON (e.document_id,e.patient_id)=(j.document_id,j.patient_id)
 JOIN public.medical_documents d ON (d.id,d.patient_id)=(j.document_id,j.patient_id)
 WHERE (j.document_id,j.patient_id)=(s.document_id,s.patient_id) AND j.state='completed'
 AND public.document_accessible(d.id,d.patient_id) AND e.processing_status='completed' AND d.sha256=e.source_metadata#>>'{source,sha256}'
 AND e.id=s.extraction_id AND e.processing_attempt=s.processing_attempt AND j.attempt_count=s.processing_attempt
 AND e.processing_claim_token=s.processing_claim_token
 AND public.summary_extraction_fingerprint(e.id,e.extracted_text,e.source_metadata,e.extractor_version,e.processing_attempt,e.processing_claim_token)=s.source_fingerprint)
$$;
CREATE OR REPLACE FUNCTION public.guard_summary_job() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
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
    OR OLD.state IN ('completed','cancelled','superseded') OR (OLD.state='failed' AND NOT(NEW.state='retry_wait' AND OLD.attempt_count<OLD.max_attempts)) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='SUMMARY_IMMUTABLE'; END IF;
  IF NOT ((OLD.state='failed' AND NEW.state='retry_wait' AND OLD.attempt_count<OLD.max_attempts) OR (OLD.state IN ('pending','retry_wait') AND NEW.state IN ('running','cancelled','superseded'))
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

CREATE TABLE public.summary_history_requests (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), patient_id UUID NOT NULL REFERENCES public.patients(id),
 manifest JSONB NOT NULL CHECK(jsonb_typeof(manifest)='array' AND jsonb_array_length(manifest) BETWEEN 1 AND 20 AND octet_length(manifest::text)<=32768),
 manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256=public.summary_digest(manifest::text)),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE(patient_id,manifest_sha256)
);
CREATE INDEX history_owner_created ON public.summary_history_requests(patient_id,created_at DESC);
CREATE FUNCTION public.history_manifest_current(manifest JSONB,patient UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_array_length(manifest)>0 AND NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(manifest) m
 LEFT JOIN public.medical_summary_jobs j ON j.id=(m->>'job_id')::uuid AND j.patient_id=patient
 LEFT JOIN public.summary_source_snapshots s ON s.id=j.snapshot_id AND s.patient_id=patient
 WHERE j.id IS NULL OR s.id IS NULL OR ((m->>'document_id')::uuid IS DISTINCT FROM s.document_id)
 OR NOT public.document_accessible(s.document_id,patient) OR NOT public.summary_source_current(s))
$$;
ALTER TABLE public.summary_history_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY history_current_access ON public.summary_history_requests TO health_wallet_app
 USING(public.history_manifest_current(manifest,patient_id)) WITH CHECK(public.history_manifest_current(manifest,patient_id));
REVOKE ALL ON public.summary_history_requests FROM PUBLIC;
GRANT SELECT,INSERT ON public.summary_history_requests TO health_wallet_app;
REVOKE ALL ON FUNCTION public.history_manifest_current(JSONB,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.history_manifest_current(JSONB,UUID) TO health_wallet_app;
-- Cancel pending/running summary work before its source becomes hidden. No
-- original/source erasure or relaxation of the Phase 3 deletion boundary.
CREATE FUNCTION public.cancel_inaccessible_summaries() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='medical_documents' THEN
  IF NEW.access_state='active' OR OLD.access_state<>'active' THEN RETURN NEW; END IF;
  UPDATE public.medical_summary_jobs SET state='cancelled',finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,last_error_code='CANCELLED'
  WHERE document_id=OLD.id AND patient_id=OLD.patient_id AND state IN ('pending','running','retry_wait');
 ELSE
  IF NEW.account_status='active' AND NEW.email_verified_at IS NOT NULL THEN RETURN NEW; END IF;
  IF OLD.account_status<>'active' OR OLD.email_verified_at IS NULL THEN RETURN NEW; END IF;
  UPDATE public.medical_summary_jobs SET state='cancelled',finished_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL,last_error_code='CANCELLED'
  WHERE patient_id=OLD.id AND state IN ('pending','running','retry_wait');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER summary_document_access BEFORE UPDATE OF access_state ON public.medical_documents FOR EACH ROW EXECUTE FUNCTION public.cancel_inaccessible_summaries();
CREATE TRIGGER summary_patient_access BEFORE UPDATE OF account_status,email_verified_at ON public.patients FOR EACH ROW EXECUTE FUNCTION public.cancel_inaccessible_summaries();
REVOKE ALL ON FUNCTION public.cancel_inaccessible_summaries() FROM PUBLIC;
