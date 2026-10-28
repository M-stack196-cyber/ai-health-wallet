-- Security-email queue: ciphertext is separated from safe operational metadata.
-- Version zero makes any pre-existing challenge fail closed after this rollout.
ALTER TABLE public.patient_auth_challenges ADD COLUMN security_version BIGINT NOT NULL DEFAULT 0;
CREATE TABLE public.patient_security_email_deliveries (
  id UUID PRIMARY KEY,
  challenge_id UUID NOT NULL UNIQUE REFERENCES public.patient_auth_challenges(id),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','delivered','transient_failed','permanent_failed','expired','superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  claim_id UUID,
  claim_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  provider_reference_hash TEXT CHECK (provider_reference_hash ~ '^[a-f0-9]{64}$'),
  failure_category TEXT CHECK (failure_category IN ('transport','timeout','rejected','invalid_receipt','invalid_payload','expired','superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delivered_at TIMESTAMPTZ,
  CHECK ((state='sending')=(claim_id IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CHECK ((state='delivered')=(delivered_at IS NOT NULL))
);
CREATE INDEX patient_security_email_due_idx ON public.patient_security_email_deliveries(next_attempt_at,id)
  WHERE state IN ('pending','transient_failed','sending');
CREATE INDEX patient_security_email_owner_idx ON public.patient_security_email_deliveries(patient_id,created_at);
CREATE TABLE public.patient_security_email_payloads (
  delivery_id UUID PRIMARY KEY REFERENCES public.patient_security_email_deliveries(id),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce)=12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 2048),
  tag BYTEA NOT NULL CHECK (octet_length(tag)=16)
);
REVOKE ALL ON public.patient_security_email_deliveries,public.patient_security_email_payloads FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON public.patient_security_email_deliveries TO health_wallet_app;
GRANT SELECT,INSERT,DELETE ON public.patient_security_email_payloads TO health_wallet_app;
