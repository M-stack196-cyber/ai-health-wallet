-- Additive temporary doctor sharing; reuse original grant/membership/OTP foundations.
ALTER TABLE public.doctor_sharing_grants
 ADD COLUMN recipient_bound BOOLEAN NOT NULL DEFAULT true,
 ADD COLUMN patient_security_version BIGINT NOT NULL DEFAULT 0,
 ADD COLUMN authorization_version BIGINT NOT NULL DEFAULT 1 CHECK(authorization_version>0);
ALTER TABLE public.patient_auth_challenges DROP CONSTRAINT patient_auth_challenges_purpose_check;
ALTER TABLE public.patient_auth_challenges ADD CONSTRAINT patient_auth_challenges_purpose_check CHECK(purpose IN ('verify_email','reset_password','guardian_invitation','doctor_share_otp'));
ALTER TABLE public.patient_security_email_deliveries DROP CONSTRAINT patient_security_email_deliveries_purpose_check;
ALTER TABLE public.patient_security_email_deliveries ADD CONSTRAINT patient_security_email_deliveries_purpose_check CHECK(purpose IN ('verify_email','reset_password','guardian_invitation','doctor_share_otp'));
DROP INDEX public.patient_auth_challenges_live_idx;
CREATE UNIQUE INDEX patient_auth_challenges_live_idx ON public.patient_auth_challenges(patient_id,purpose) WHERE consumed_at IS NULL AND purpose<>'doctor_share_otp';
ALTER TABLE public.doctor_otp_challenges
 ADD COLUMN auth_challenge_id UUID UNIQUE REFERENCES public.patient_auth_challenges(id),
 ADD COLUMN doctor_name TEXT CHECK(length(doctor_name) BETWEEN 1 AND 120),
 ADD COLUMN organization TEXT CHECK(length(organization) BETWEEN 1 AND 160);
CREATE INDEX doctor_otp_auth_scope ON public.doctor_otp_challenges(grant_id,doctor_email,created_at DESC);
CREATE TABLE public.doctor_share_sessions(
 id UUID PRIMARY KEY,grant_id UUID NOT NULL,patient_id UUID NOT NULL,doctor_email TEXT NOT NULL,
 doctor_name TEXT NOT NULL CHECK(length(doctor_name) BETWEEN 1 AND 120),organization TEXT CHECK(length(organization) BETWEEN 1 AND 160),
 challenge_id UUID NOT NULL UNIQUE REFERENCES public.doctor_otp_challenges(id),token_hash TEXT NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 grant_version BIGINT NOT NULL,patient_security_version BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),expires_at TIMESTAMPTZ NOT NULL,revoked_at TIMESTAMPTZ,
 FOREIGN KEY(grant_id,patient_id,doctor_email) REFERENCES public.doctor_sharing_grants(id,patient_id,doctor_email),CHECK(expires_at>created_at)
);
CREATE INDEX doctor_session_grant ON public.doctor_share_sessions(grant_id,patient_id);
CREATE TABLE public.doctor_share_events(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),grant_id UUID REFERENCES public.doctor_sharing_grants(id),
 event TEXT NOT NULL CHECK(event IN ('created','opened','otp_requested','otp_verified','otp_failed','authorized','denied','download','revoked','expiry_denied')),
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX doctor_event_grant ON public.doctor_share_events(grant_id,occurred_at);
REVOKE ALL ON public.doctor_share_sessions,public.doctor_share_events FROM PUBLIC,health_wallet_app;
GRANT SELECT,INSERT,UPDATE ON public.doctor_share_sessions TO health_wallet_app;
GRANT SELECT,INSERT ON public.doctor_share_events TO health_wallet_app;
CREATE FUNCTION public.doctor_document_current(session_hash TEXT,doc UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.doctor_share_sessions s
 JOIN public.doctor_sharing_grants g ON (g.id,g.patient_id,g.doctor_email)=(s.grant_id,s.patient_id,s.doctor_email)
 JOIN public.patients p ON p.id=g.patient_id JOIN public.sharing_grant_documents m ON (m.grant_id,m.patient_id)=(g.id,g.patient_id)
 WHERE s.token_hash=session_hash AND m.document_id=doc AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND s.grant_version=g.authorization_version
 AND s.patient_security_version=p.security_version AND g.patient_security_version=p.security_version
 AND p.account_status='active' AND p.email_verified_at IS NOT NULL AND public.document_accessible(doc,p.id))
$$;
REVOKE ALL ON FUNCTION public.doctor_document_current(TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.doctor_document_current(TEXT,UUID) TO health_wallet_app;
ALTER POLICY rag_vector_scope ON public.rag_chunk_embeddings
 USING(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND public.rag_chunk_current(chunk_id,patient_id,snapshot_id,source_fingerprint)
 AND (NULLIF(current_setting('app.doctor_session_hash',true),'') IS NULL OR public.doctor_document_current(current_setting('app.doctor_session_hash',true),document_id)))
 WITH CHECK(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND public.rag_chunk_current(chunk_id,patient_id,snapshot_id,source_fingerprint)
 AND NULLIF(current_setting('app.doctor_session_hash',true),'') IS NULL);
ALTER TABLE public.rag_interactions DROP CONSTRAINT rag_result_shape;
ALTER TABLE public.rag_interactions ADD CONSTRAINT rag_result_shape CHECK(rag_contract_version IS NULL OR
 (result_status IS NOT NULL AND answer IS NOT NULL AND structured_answer IS NOT NULL AND provenance IS NOT NULL AND octet_length(structured_answer::text)<=131072));
CREATE POLICY rag_doctor_insert ON public.rag_interactions FOR INSERT TO health_wallet_app WITH CHECK(
 rag_contract_version=1 AND sharing_grant_id IS NOT NULL AND patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid
 AND EXISTS(SELECT 1 FROM public.doctor_share_sessions s JOIN public.doctor_sharing_grants g ON g.id=s.grant_id JOIN public.patients p ON p.id=g.patient_id
 WHERE s.token_hash=current_setting('app.doctor_session_hash',true) AND s.grant_id=rag_interactions.sharing_grant_id AND s.patient_id=rag_interactions.patient_id AND s.revoked_at IS NULL
 AND s.expires_at>clock_timestamp() AND g.expires_at>clock_timestamp() AND g.revoked_at IS NULL AND s.grant_version=g.authorization_version
 AND p.security_version=s.patient_security_version AND p.security_version=g.patient_security_version AND p.account_status='active' AND p.email_verified_at IS NOT NULL));
ALTER POLICY rag_evidence_scope ON public.rag_answer_evidence
 USING(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND public.rag_chunk_current(chunk_id,patient_id,snapshot_id,source_fingerprint)
 AND (NULLIF(current_setting('app.doctor_session_hash',true),'') IS NULL OR public.doctor_document_current(current_setting('app.doctor_session_hash',true),document_id)))
 WITH CHECK(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND public.rag_chunk_current(chunk_id,patient_id,snapshot_id,source_fingerprint)
 AND (NULLIF(current_setting('app.doctor_session_hash',true),'') IS NULL OR public.doctor_document_current(current_setting('app.doctor_session_hash',true),document_id)));
-- The original source helper still enforces current extraction/deletion; add
-- grant membership/expiry for retained substantive doctor answers as well.
CREATE OR REPLACE FUNCTION public.rag_sources_accessible(interaction UUID,patient UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN r.rag_contract_version=1 THEN
 EXISTS(SELECT 1 FROM public.rag_answer_evidence e WHERE e.interaction_id=r.id AND e.patient_id=patient)
 AND NOT EXISTS(SELECT 1 FROM public.rag_answer_evidence e WHERE e.interaction_id=r.id AND e.patient_id=patient AND
 (NOT public.rag_chunk_current(e.chunk_id,patient,e.snapshot_id,e.source_fingerprint) OR (r.sharing_grant_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM public.sharing_grant_documents m JOIN public.doctor_sharing_grants g ON (g.id,g.patient_id)=(m.grant_id,m.patient_id)
 JOIN public.patients p ON p.id=g.patient_id WHERE m.grant_id=r.sharing_grant_id AND m.document_id=e.document_id AND m.patient_id=patient
 AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND g.patient_security_version=p.security_version))))
 ELSE EXISTS(SELECT 1 FROM public.rag_interaction_sources s WHERE s.interaction_id=interaction AND s.patient_id=patient)
 AND NOT EXISTS(SELECT 1 FROM public.rag_interaction_sources s WHERE s.interaction_id=interaction AND s.patient_id=patient AND NOT public.document_accessible(s.document_id,patient)) END
 FROM public.rag_interactions r WHERE r.id=interaction AND r.patient_id=patient
$$;
