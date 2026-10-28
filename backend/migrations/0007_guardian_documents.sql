-- Phase 2: additive lifecycle. Historical contacts carry no verified authority.
ALTER TABLE public.patient_auth_challenges DROP CONSTRAINT patient_auth_challenges_purpose_check;
ALTER TABLE public.patient_auth_challenges ADD CONSTRAINT patient_auth_challenges_purpose_check
 CHECK (purpose IN ('verify_email','reset_password','guardian_invitation'));
ALTER TABLE public.patient_security_email_deliveries DROP CONSTRAINT patient_security_email_deliveries_purpose_check;
ALTER TABLE public.patient_security_email_deliveries ADD CONSTRAINT patient_security_email_deliveries_purpose_check
 CHECK (purpose IN ('verify_email','reset_password','guardian_invitation'));
CREATE TABLE public.guardian_relationships (
 id UUID PRIMARY KEY, patient_id UUID NOT NULL REFERENCES public.patients(id),
 email TEXT NOT NULL CHECK (email=lower(btrim(email)) AND length(email) BETWEEN 3 AND 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
 status TEXT NOT NULL CHECK(status IN ('PENDING','ACTIVE','REVOKED','EXPIRED')),
 invitation_id UUID UNIQUE REFERENCES public.patient_auth_challenges(id),
 accepted_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK(status<>'ACTIVE' OR (accepted_at IS NOT NULL AND invitation_id IS NOT NULL)),
 CHECK((status='REVOKED')=(revoked_at IS NOT NULL)), UNIQUE(id,patient_id)
);
CREATE UNIQUE INDEX guardian_one_primary ON public.guardian_relationships(patient_id) WHERE status IN ('PENDING','ACTIVE');
CREATE INDEX guardian_owner_history ON public.guardian_relationships(patient_id,created_at DESC,id);
CREATE TABLE public.guardian_lifecycle_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), patient_id UUID NOT NULL REFERENCES public.patients(id),
 relationship_id UUID NOT NULL, event TEXT NOT NULL CHECK(event IN ('nominated','resent','accepted','revoked','expired')),
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(relationship_id,patient_id) REFERENCES public.guardian_relationships(id,patient_id)
);
CREATE INDEX guardian_event_owner ON public.guardian_lifecycle_events(patient_id,occurred_at);
-- Future M10 must resolve this at the delivery boundary, never a cached email/contact.
CREATE VIEW public.guardian_communication_eligibility AS
 SELECT g.id AS relationship_id,g.patient_id,g.email FROM public.guardian_relationships g
 JOIN public.patients p ON p.id=g.patient_id
 WHERE g.status='ACTIVE' AND g.accepted_at IS NOT NULL AND g.revoked_at IS NULL
 AND p.account_status='active' AND p.email_verified_at IS NOT NULL;
REVOKE ALL ON public.guardian_relationships,public.guardian_lifecycle_events,public.guardian_communication_eligibility FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.guardian_relationships TO health_wallet_app;
GRANT SELECT,INSERT ON public.guardian_lifecycle_events TO health_wallet_app;
GRANT SELECT ON public.guardian_communication_eligibility TO health_wallet_app;

-- Legacy unknown integrity stays NULL, never fabricated/backfilled from an unverified object.
ALTER TABLE public.medical_documents ADD COLUMN content_type TEXT, ADD COLUMN size_bytes BIGINT,
 ADD COLUMN sha256 TEXT, ADD CONSTRAINT document_integrity_shape CHECK (
 (content_type IS NULL AND size_bytes IS NULL AND sha256 IS NULL) OR
 (content_type IS NOT NULL AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND size_bytes BETWEEN 1 AND 20971520 AND sha256 ~ '^[a-f0-9]{64}$'
  AND content_type=CASE file_type WHEN 'pdf' THEN 'application/pdf' WHEN 'png' THEN 'image/png' ELSE 'image/jpeg' END));
CREATE FUNCTION public.preserve_original_identity() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' AND (NEW.content_type IS NULL OR NEW.size_bytes IS NULL OR NEW.sha256 IS NULL) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Verified original metadata required';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.patient_id,NEW.s3_bucket,NEW.s3_object_key,NEW.file_type,NEW.original_filename,NEW.uploaded_at,NEW.content_type,NEW.size_bytes,NEW.sha256)
  IS DISTINCT FROM (OLD.id,OLD.patient_id,OLD.s3_bucket,OLD.s3_object_key,OLD.file_type,OLD.original_filename,OLD.uploaded_at,OLD.content_type,OLD.size_bytes,OLD.sha256) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Original identity is immutable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER document_original_immutable BEFORE INSERT OR UPDATE ON public.medical_documents
 FOR EACH ROW EXECUTE FUNCTION public.preserve_original_identity();
REVOKE ALL ON FUNCTION public.preserve_original_identity() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preserve_original_identity() TO health_wallet_app;
-- Existing completed means extraction-only. Preserve extraction evidence; correct aggregate state.
UPDATE public.medical_documents SET processing_status='processing' WHERE processing_status='completed';

-- Extraction completion does not claim OCR/AI/index/summary aggregate completion.
CREATE OR REPLACE FUNCTION public.persist_document_extraction(doc UUID,patient UUID,token UUID,body TEXT,meta JSONB,version TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE job public.document_processing_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job FROM public.document_processing_jobs WHERE document_id=doc AND patient_id=patient FOR UPDATE;
  IF NOT FOUND OR job.state<>'running' OR job.lease_token IS DISTINCT FROM token
    OR job.lease_expires_at<=clock_timestamp() OR job.attempt_deadline_at<=clock_timestamp() THEN RETURN false; END IF;
  IF public.valid_extraction_payload(body,meta,version) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid extraction evidence';
  END IF;
  IF EXISTS(SELECT 1 FROM public.medical_documents WHERE id=doc AND patient_id=patient AND sha256 IS NOT NULL AND sha256 IS DISTINCT FROM meta#>>'{source,sha256}') THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Extraction source digest mismatch';
  END IF;
  INSERT INTO public.extracted_medical_text(document_id,patient_id,extracted_text,processing_status,source_metadata,extractor_version,processing_attempt,processing_claim_token)
    VALUES(doc,patient,body,'completed',meta,version,job.attempt_count,token)
    ON CONFLICT(document_id,patient_id) DO UPDATE SET extracted_text=EXCLUDED.extracted_text,processing_status=EXCLUDED.processing_status,
      source_metadata=EXCLUDED.source_metadata,extractor_version=EXCLUDED.extractor_version,
      processing_attempt=EXCLUDED.processing_attempt,processing_claim_token=EXCLUDED.processing_claim_token;
  UPDATE public.document_processing_jobs SET state='completed',finished_at=clock_timestamp(),lease_token=NULL,
    lease_expires_at=NULL,attempt_deadline_at=NULL,last_error_code=NULL
    WHERE document_id=doc AND patient_id=patient AND state='running' AND lease_token=token
      AND lease_expires_at>clock_timestamp() AND attempt_deadline_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Extraction claim expired'; END IF;
  UPDATE public.medical_documents SET processing_status='processing' WHERE id=doc AND patient_id=patient AND processing_status='processing';
  IF NOT FOUND OR job.lease_expires_at<=clock_timestamp() OR job.attempt_deadline_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Extraction completion could not be confirmed';
  END IF;
  RETURN true;
END;
$$;
-- No aggregate-completion authority exists yet. Extraction workers cannot claim it.
CREATE FUNCTION public.document_aggregate_completion_gate() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.processing_status='completed' THEN NEW.processing_status:='processing'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER document_aggregate_gate BEFORE INSERT OR UPDATE ON public.medical_documents
 FOR EACH ROW EXECUTE FUNCTION public.document_aggregate_completion_gate();
REVOKE ALL ON FUNCTION public.document_aggregate_completion_gate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.document_aggregate_completion_gate() TO health_wallet_app;
CREATE FUNCTION public.guardian_relationship_guard() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.status<>'PENDING' THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Guardian must begin pending';
 END IF;
 IF TG_OP='UPDATE' AND ((NEW.id,NEW.patient_id,NEW.email,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.patient_id,OLD.email,OLD.created_at)
  OR (OLD.status IN ('REVOKED','EXPIRED') AND NEW.status NOT IN (OLD.status,'REVOKED'))) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Guardian identity and revocation are immutable';
 END IF;
 IF NEW.invitation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.patient_auth_challenges c
  WHERE c.id=NEW.invitation_id AND c.patient_id=NEW.patient_id AND c.purpose='guardian_invitation') THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Guardian invitation ownership mismatch';
 END IF;
 IF NEW.status='ACTIVE' AND (TG_OP='INSERT' OR OLD.status<>'ACTIVE') AND NOT EXISTS(
  SELECT 1 FROM public.patient_auth_challenges c JOIN public.patients p ON p.id=c.patient_id
  WHERE c.id=NEW.invitation_id AND c.patient_id=NEW.patient_id AND c.purpose='guardian_invitation'
  AND c.consumed_at IS NOT NULL AND c.expires_at>clock_timestamp() AND c.security_version=p.security_version
  AND p.account_status='active' AND p.email_verified_at IS NOT NULL) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Guardian acceptance evidence required';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER guardian_relationship_fence BEFORE INSERT OR UPDATE ON public.guardian_relationships
 FOR EACH ROW EXECUTE FUNCTION public.guardian_relationship_guard();
REVOKE ALL ON FUNCTION public.guardian_relationship_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_relationship_guard() TO health_wallet_app;
