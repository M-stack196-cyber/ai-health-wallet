-- M13 Phase R2 follow-up: physical-deletion policy gate and guardian-link counter.
-- Developer-proposed, not reviewer-approved. CFG-12 and CFG-18 are a legal decision still pending.
-- The 30-day retention value is a labelled PLACEHOLDER only: it is not approved, not shown to patients as a promise,
-- and nothing may use it to delete anything. Physical deletion stays impossible until a later, owner-controlled
-- migration records a named legal/privacy approval. The application role cannot change this table.

CREATE TABLE public.deletion_policy (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  -- The only value this migration allows. An approved state needs a new, reviewed, owner-run migration.
  status TEXT NOT NULL DEFAULT 'policy_pending' CHECK (status = 'policy_pending'),
  approved BOOLEAN NOT NULL DEFAULT FALSE CHECK (approved = FALSE),
  retention_days_placeholder INTEGER NOT NULL DEFAULT 30 CHECK (retention_days_placeholder BETWEEN 1 AND 3650),
  retention_label TEXT NOT NULL DEFAULT 'placeholder_not_approved' CHECK (retention_label = 'placeholder_not_approved'),
  cfg_reference TEXT NOT NULL DEFAULT 'CFG-12/CFG-18 legal decision pending' CHECK (length(cfg_reference) BETWEEN 1 AND 100),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.deletion_policy DEFAULT VALUES;

-- Every future physical-deletion code path must call this first. While the policy is pending it always raises.
CREATE FUNCTION public.assert_physical_deletion_allowed() RETURNS VOID
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.deletion_policy WHERE approved AND status = 'approved') THEN
    RAISE EXCEPTION 'physical deletion is blocked: deletion policy is pending (CFG-12/CFG-18)' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Guardian links ended by a deletion request (count only, no personal data).
ALTER TABLE public.patient_deletion_requests
  ADD COLUMN guardian_links_revoked INTEGER NOT NULL DEFAULT 0 CHECK (guardian_links_revoked >= 0);

REVOKE ALL ON TABLE public.deletion_policy FROM PUBLIC, health_wallet_app;
GRANT SELECT ON TABLE public.deletion_policy TO health_wallet_app;
REVOKE ALL ON FUNCTION public.assert_physical_deletion_allowed() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_physical_deletion_allowed() TO health_wallet_app;
