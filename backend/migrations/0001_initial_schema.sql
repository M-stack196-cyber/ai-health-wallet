-- Phase 1.4: metadata only. No medical binaries, plaintext credentials or vectors.
-- All relationships use restrictive deletion to avoid accidental record loss.
CREATE TABLE public.patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
  date_of_birth DATE,
  phone_number TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT patients_email_format CHECK (email = lower(btrim(email)) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  CONSTRAINT patients_password_hash_format CHECK (
    length(password_hash) >= 40 AND password_hash ~ '^\$(argon2(id|i|d)\$|2[aby]\$)'
  )
);

CREATE TABLE public.guardian_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  full_name TEXT,
  consented_at TIMESTAMPTZ,
  consent_version TEXT CHECK (length(btrim(consent_version)) > 0),
  consent_revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (patient_id, email),
  UNIQUE (id, patient_id),
  CONSTRAINT guardian_consent_record CHECK ((consented_at IS NULL) = (consent_version IS NULL)),
  CONSTRAINT guardian_consent_revocation CHECK (
    consent_revoked_at IS NULL OR (consented_at IS NOT NULL AND consent_revoked_at >= consented_at)
  )
);

CREATE TABLE public.medical_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  s3_bucket TEXT NOT NULL CHECK (length(btrim(s3_bucket)) > 0),
  s3_object_key TEXT NOT NULL CHECK (length(btrim(s3_object_key)) > 0 AND s3_object_key !~* '^https?://'),
  original_filename TEXT NOT NULL CHECK (length(btrim(original_filename)) > 0),
  file_type TEXT NOT NULL CHECK (file_type IN ('pdf', 'jpg', 'jpeg', 'png')),
  category TEXT NOT NULL CHECK (category IN ('lab_report', 'prescription', 'other_medical_document')),
  hospital_name TEXT CHECK (length(btrim(hospital_name)) > 0),
  document_date DATE,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_status TEXT NOT NULL DEFAULT 'processing' CHECK (processing_status IN ('processing', 'completed', 'failed')),
  UNIQUE (id, patient_id),
  UNIQUE (s3_bucket, s3_object_key)
);

CREATE INDEX medical_documents_patient_upload_idx ON public.medical_documents (patient_id, uploaded_at DESC, id);
CREATE INDEX medical_documents_patient_hospital_idx ON public.medical_documents (patient_id, lower(hospital_name), uploaded_at DESC);
CREATE INDEX medical_documents_patient_category_idx ON public.medical_documents (patient_id, category, uploaded_at DESC);
-- A date has no timezone: the fallback uses UTC explicitly and is indexable.
CREATE INDEX medical_documents_patient_timeline_idx ON public.medical_documents
  (patient_id, (COALESCE(document_date, (uploaded_at AT TIME ZONE 'UTC')::date)) DESC, uploaded_at DESC, id);

CREATE TABLE public.extracted_medical_text (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  extracted_text TEXT,
  processing_status TEXT NOT NULL DEFAULT 'processing' CHECK (processing_status IN ('processing', 'completed', 'failed')),
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_metadata) = 'object'),
  extractor_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, patient_id),
  FOREIGN KEY (document_id, patient_id) REFERENCES public.medical_documents(id, patient_id),
  CONSTRAINT extracted_text_completed CHECK (processing_status <> 'completed' OR (extracted_text IS NOT NULL AND length(btrim(extracted_text)) > 0))
);
CREATE INDEX extracted_medical_text_patient_idx ON public.extracted_medical_text (patient_id, document_id);

CREATE TABLE public.medical_document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  chunk_order INTEGER NOT NULL CHECK (chunk_order >= 0),
  chunk_text TEXT NOT NULL CHECK (length(btrim(chunk_text)) > 0),
  source_reference JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_reference) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, patient_id, chunk_order),
  FOREIGN KEY (document_id, patient_id) REFERENCES public.medical_documents(id, patient_id)
);
CREATE INDEX medical_document_chunks_patient_idx ON public.medical_document_chunks (patient_id, document_id, chunk_order);

CREATE TABLE public.ai_report_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  summary_text TEXT,
  processing_status TEXT NOT NULL DEFAULT 'processing' CHECK (processing_status IN ('processing', 'completed', 'failed')),
  model_name TEXT,
  model_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_at TIMESTAMPTZ,
  UNIQUE (id, document_id, patient_id),
  FOREIGN KEY (document_id, patient_id) REFERENCES public.medical_documents(id, patient_id),
  CONSTRAINT summary_completed CHECK (processing_status <> 'completed' OR (
    summary_text IS NOT NULL AND length(btrim(summary_text)) > 0 AND generated_at IS NOT NULL
  )),
  CONSTRAINT summary_generation_time CHECK (generated_at IS NULL OR generated_at >= created_at)
);
CREATE INDEX ai_report_summaries_document_idx ON public.ai_report_summaries (document_id, patient_id);
CREATE INDEX ai_report_summaries_patient_idx ON public.ai_report_summaries (patient_id, created_at DESC);

CREATE TABLE public.doctor_sharing_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  doctor_email TEXT NOT NULL CHECK (doctor_email = lower(btrim(doctor_email)) AND doctor_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  sharing_method TEXT NOT NULL CHECK (sharing_method IN ('qr_code', 'unique_link')),
  token_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (id, patient_id),
  UNIQUE (id, patient_id, doctor_email),
  CONSTRAINT sharing_grant_expiry CHECK (expires_at > created_at),
  CONSTRAINT sharing_grant_revocation CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX doctor_sharing_grants_patient_idx ON public.doctor_sharing_grants (patient_id, created_at DESC);

CREATE TABLE public.sharing_grant_documents (
  grant_id UUID NOT NULL,
  document_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  PRIMARY KEY (grant_id, document_id),
  UNIQUE (grant_id, document_id, patient_id),
  FOREIGN KEY (grant_id, patient_id) REFERENCES public.doctor_sharing_grants(id, patient_id),
  FOREIGN KEY (document_id, patient_id) REFERENCES public.medical_documents(id, patient_id)
);
CREATE INDEX sharing_grant_documents_grant_patient_idx ON public.sharing_grant_documents (grant_id, patient_id);
CREATE INDEX sharing_grant_documents_document_idx ON public.sharing_grant_documents (document_id, patient_id);
CREATE INDEX sharing_grant_documents_patient_idx ON public.sharing_grant_documents (patient_id, grant_id);

CREATE TABLE public.doctor_otp_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  doctor_email TEXT NOT NULL,
  otp_verifier BYTEA NOT NULL CHECK (octet_length(otp_verifier) = 32),
  verifier_key_version TEXT NOT NULL CHECK (length(btrim(verifier_key_version)) > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (grant_id, patient_id, doctor_email) REFERENCES public.doctor_sharing_grants(id, patient_id, doctor_email),
  CONSTRAINT otp_expiry CHECK (expires_at > created_at),
  CONSTRAINT otp_verification_time CHECK (verified_at IS NULL OR (verified_at >= created_at AND verified_at < expires_at))
);
CREATE INDEX doctor_otp_challenges_grant_idx ON public.doctor_otp_challenges (grant_id, patient_id, doctor_email, created_at DESC);
CREATE INDEX doctor_otp_challenges_patient_idx ON public.doctor_otp_challenges (patient_id, created_at DESC);

CREATE TABLE public.guardian_notification_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL,
  document_id UUID NOT NULL,
  guardian_contact_id UUID NOT NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN ('routine_report', 'serious_report_alert')),
  delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  failure_code TEXT CHECK (length(btrim(failure_code)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  FOREIGN KEY (document_id, patient_id) REFERENCES public.medical_documents(id, patient_id),
  FOREIGN KEY (guardian_contact_id, patient_id) REFERENCES public.guardian_contacts(id, patient_id),
  CONSTRAINT notification_delivery_state CHECK ((delivery_status = 'sent') = (delivered_at IS NOT NULL)),
  CONSTRAINT notification_delivery_time CHECK (delivered_at IS NULL OR delivered_at >= created_at)
);
CREATE INDEX guardian_notifications_document_idx ON public.guardian_notification_events (document_id, patient_id);
CREATE INDEX guardian_notifications_guardian_idx ON public.guardian_notification_events (guardian_contact_id, patient_id);
CREATE INDEX guardian_notifications_patient_idx ON public.guardian_notification_events (patient_id, created_at DESC);

CREATE TABLE public.serious_finding_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  rule_set_version TEXT NOT NULL CHECK (length(btrim(rule_set_version)) > 0),
  detection_result TEXT NOT NULL CHECK (detection_result IN ('flagged', 'not_flagged', 'indeterminate')),
  flagged_findings JSONB CHECK (jsonb_typeof(flagged_findings) = 'array'),
  ai_summary_id UUID,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (document_id, patient_id) REFERENCES public.medical_documents(id, patient_id),
  FOREIGN KEY (ai_summary_id, document_id, patient_id) REFERENCES public.ai_report_summaries(id, document_id, patient_id),
  CONSTRAINT flagged_findings_required CHECK (detection_result <> 'flagged' OR (
    flagged_findings IS NOT NULL AND jsonb_array_length(flagged_findings) > 0
  )),
  CONSTRAINT not_flagged_findings_empty CHECK (detection_result <> 'not_flagged' OR (
    flagged_findings IS NULL OR jsonb_array_length(flagged_findings) = 0
  ))
);
CREATE INDEX serious_finding_evaluations_document_idx ON public.serious_finding_evaluations (document_id, patient_id, evaluated_at DESC);
CREATE INDEX serious_finding_evaluations_summary_idx ON public.serious_finding_evaluations (ai_summary_id, document_id, patient_id);
CREATE INDEX serious_finding_evaluations_patient_idx ON public.serious_finding_evaluations (patient_id, evaluated_at DESC);

CREATE TABLE public.rag_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  sharing_grant_id UUID,
  question TEXT NOT NULL CHECK (length(btrim(question)) > 0),
  answer TEXT CHECK (length(btrim(answer)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, patient_id),
  UNIQUE (id, patient_id, sharing_grant_id),
  FOREIGN KEY (sharing_grant_id, patient_id) REFERENCES public.doctor_sharing_grants(id, patient_id)
);
CREATE INDEX rag_interactions_patient_idx ON public.rag_interactions (patient_id, created_at DESC);
CREATE INDEX rag_interactions_grant_idx ON public.rag_interactions (sharing_grant_id, patient_id);

CREATE TABLE public.rag_interaction_sources (
  interaction_id UUID NOT NULL,
  document_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  sharing_grant_id UUID,
  PRIMARY KEY (interaction_id, document_id),
  FOREIGN KEY (interaction_id, patient_id) REFERENCES public.rag_interactions(id, patient_id),
  -- MATCH SIMPLE permits patient-only interactions. The trigger below makes
  -- NULL/non-NULL grant identity match the interaction, preventing NULL bypass.
  FOREIGN KEY (interaction_id, patient_id, sharing_grant_id) REFERENCES public.rag_interactions(id, patient_id, sharing_grant_id),
  FOREIGN KEY (document_id, patient_id) REFERENCES public.medical_documents(id, patient_id),
  FOREIGN KEY (sharing_grant_id, document_id, patient_id) REFERENCES public.sharing_grant_documents(grant_id, document_id, patient_id)
);
CREATE INDEX rag_interaction_sources_interaction_idx ON public.rag_interaction_sources (interaction_id, patient_id, sharing_grant_id);
CREATE INDEX rag_interaction_sources_document_idx ON public.rag_interaction_sources (document_id, patient_id);
CREATE INDEX rag_interaction_sources_grant_idx ON public.rag_interaction_sources (sharing_grant_id, document_id, patient_id);
CREATE INDEX rag_interaction_sources_patient_idx ON public.rag_interaction_sources (patient_id, interaction_id);

CREATE FUNCTION public.enforce_rag_source_authorization() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE expected_grant UUID;
BEGIN
  SELECT sharing_grant_id INTO expected_grant FROM public.rag_interactions
    WHERE id = NEW.interaction_id AND patient_id = NEW.patient_id FOR SHARE;
  IF NOT FOUND OR NEW.sharing_grant_id IS DISTINCT FROM expected_grant THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'RAG source authorization does not match interaction';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rag_source_authorization BEFORE INSERT OR UPDATE ON public.rag_interaction_sources
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rag_source_authorization();

-- Once recorded, an interaction's authorization context is immutable; this
-- closes the reverse NULL transition bypass while preserving history.
CREATE FUNCTION public.preserve_rag_authorization() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.sharing_grant_id IS DISTINCT FROM OLD.sharing_grant_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'RAG interaction authorization is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rag_authorization_immutable BEFORE UPDATE ON public.rag_interactions
  FOR EACH ROW EXECUTE FUNCTION public.preserve_rag_authorization();

CREATE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER patients_updated_at BEFORE UPDATE ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER guardian_contacts_updated_at BEFORE UPDATE ON public.guardian_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER extracted_medical_text_updated_at BEFORE UPDATE ON public.extracted_medical_text
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
