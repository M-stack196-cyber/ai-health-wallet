-- M13 Phase R2: non-destructive account deletion request. Records the request, ends all access and
-- honours legal holds. No data, file, chunk, embedding or summary is deleted here: physical deletion
-- stays blocked until CFG-12/CFG-18 retention values and final legal/privacy approval exist.
-- State mapping: policy_pending -> patients.account_status 'deletion_pending';
--                blocked_legal_hold -> patients.account_status 'deletion_restricted'.

-- A hold is placed and released out-of-band by the owner role (no application endpoint in this phase).
CREATE TABLE public.patient_legal_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z_]{3,40}$'),
  placed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  released_at TIMESTAMPTZ,
  CONSTRAINT legal_hold_release_order CHECK (released_at IS NULL OR released_at >= placed_at)
);
CREATE INDEX patient_legal_holds_active_idx ON public.patient_legal_holds(patient_id) WHERE released_at IS NULL;

CREATE TABLE public.patient_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL UNIQUE REFERENCES public.patients(id),
  state TEXT NOT NULL CHECK (state IN ('policy_pending','blocked_legal_hold')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  sessions_revoked INTEGER NOT NULL CHECK (sessions_revoked >= 0),
  grants_revoked INTEGER NOT NULL CHECK (grants_revoked >= 0),
  doctor_sessions_revoked INTEGER NOT NULL CHECK (doctor_sessions_revoked >= 0)
);

-- Minimal audit: event names and counts only, never record content or credentials.
CREATE TABLE public.patient_deletion_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.patient_deletion_requests(id),
  patient_id UUID NOT NULL REFERENCES public.patients(id),
  event TEXT NOT NULL CHECK (event IN ('requested','access_revoked','legal_hold_blocked')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX patient_deletion_audit_request_idx ON public.patient_deletion_audit(request_id, occurred_at);

-- A deletion state can never go back to an access-granting state through the application role.
CREATE FUNCTION public.guard_patient_deletion_state() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.account_status IN ('deletion_pending','deletion_restricted','deleted')
    AND NEW.account_status NOT IN ('deletion_pending','deletion_restricted','deleted','revoked') THEN
    RAISE EXCEPTION 'deletion state cannot be reversed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patient_deletion_state_guard BEFORE UPDATE OF account_status ON public.patients
FOR EACH ROW EXECUTE FUNCTION public.guard_patient_deletion_state();

REVOKE ALL ON TABLE public.patient_legal_holds, public.patient_deletion_requests, public.patient_deletion_audit FROM PUBLIC, health_wallet_app;
GRANT SELECT ON TABLE public.patient_legal_holds TO health_wallet_app;
GRANT SELECT, INSERT ON TABLE public.patient_deletion_requests, public.patient_deletion_audit TO health_wallet_app;
REVOKE ALL ON FUNCTION public.guard_patient_deletion_state() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_patient_deletion_state() TO health_wallet_app;
