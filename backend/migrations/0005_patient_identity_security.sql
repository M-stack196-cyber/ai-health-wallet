-- Additive identity foundation. Existing accounts must verify; no grandfathered sessions.
ALTER TABLE public.patients
  ADD COLUMN email_verified_at TIMESTAMPTZ,
  ADD COLUMN account_status TEXT NOT NULL DEFAULT 'unverified'
    CHECK (account_status IN ('unverified','active','suspended','deletion_pending','deletion_restricted','deleted','revoked')),
  ADD COLUMN security_version BIGINT NOT NULL DEFAULT 1 CHECK (security_version > 0),
  ADD COLUMN sex_gender TEXT CHECK (sex_gender IN ('female','male','other','prefer_not_to_say')),
  ADD COLUMN pending_guardian_email TEXT CHECK (pending_guardian_email IS NULL OR
    (pending_guardian_email = lower(btrim(pending_guardian_email)) AND length(pending_guardian_email) <= 254)),
  ADD CONSTRAINT active_patient_verified CHECK (account_status <> 'active' OR email_verified_at IS NOT NULL);

CREATE TABLE public.patient_auth_sessions (
  id UUID PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  security_version BIGINT NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE CHECK (refresh_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at AND idle_expires_at <= expires_at)
);
CREATE INDEX patient_auth_sessions_owner_idx ON public.patient_auth_sessions(patient_id, id);
CREATE TABLE public.patient_refresh_history (
  session_id UUID NOT NULL REFERENCES public.patient_auth_sessions(id),
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  used_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(session_id, token_hash)
);
CREATE TABLE public.patient_auth_challenges (
  id UUID PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX patient_auth_challenges_owner_idx ON public.patient_auth_challenges(patient_id,purpose,created_at DESC);
CREATE UNIQUE INDEX patient_auth_challenges_live_idx ON public.patient_auth_challenges(patient_id,purpose) WHERE consumed_at IS NULL;
CREATE TABLE public.patient_security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID REFERENCES public.patients(id),
  session_id UUID,
  event TEXT NOT NULL CHECK (event IN ('challenge_issued','email_verified','login_succeeded','login_failed',
    'session_revoked','refresh_rotated','refresh_replay','password_reset','password_changed','delivery_failed')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX patient_security_events_owner_time_idx ON public.patient_security_events(patient_id,occurred_at DESC);
CREATE TABLE public.patient_auth_rate_limits (
  bucket_hash TEXT PRIMARY KEY CHECK (bucket_hash ~ '^[a-f0-9]{64}$'),
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);

-- Direct operational state changes cannot restore previously issued credentials.
CREATE FUNCTION public.invalidate_patient_security_state() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.account_status IS DISTINCT FROM OLD.account_status
    OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
    OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.security_version := OLD.security_version + 1;
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email_verified_at := NULL;
    NEW.account_status := 'unverified';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patient_security_state_changed BEFORE UPDATE ON public.patients
FOR EACH ROW EXECUTE FUNCTION public.invalidate_patient_security_state();

REVOKE ALL ON TABLE public.patient_auth_sessions, public.patient_refresh_history,
  public.patient_auth_challenges, public.patient_security_events, public.patient_auth_rate_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.patient_auth_sessions, public.patient_auth_challenges,
  public.patient_auth_rate_limits TO health_wallet_app;
GRANT SELECT, INSERT ON TABLE public.patient_refresh_history, public.patient_security_events TO health_wallet_app;
REVOKE ALL ON FUNCTION public.invalidate_patient_security_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invalidate_patient_security_state() TO health_wallet_app;
