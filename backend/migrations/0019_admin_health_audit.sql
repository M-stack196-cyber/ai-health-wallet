-- M13 Phase 6: system health and audit review. The two functions return aggregate counts and migration ledger
-- metadata only (no patient rows, no secrets). They are definer functions because row-level security hides some
-- processing jobs from the API role and the ledger table is owned by the migration role.
CREATE FUNCTION public.admin_processing_queue_health() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT jsonb_build_object(
  'pending', count(*) FILTER (WHERE state='pending'),
  'running', count(*) FILTER (WHERE state='running'),
  'retry_wait', count(*) FILTER (WHERE state='retry_wait'),
  'failed_last_24h', count(*) FILTER (WHERE state='failed' AND finished_at > clock_timestamp()-interval '24 hours'),
  'expired_leases', count(*) FILTER (WHERE state='running' AND lease_expires_at <= clock_timestamp()),
  'oldest_ready_age_seconds', (SELECT floor(extract(epoch FROM clock_timestamp()-min(next_attempt_at)))::bigint
    FROM public.document_processing_jobs WHERE state IN ('pending','retry_wait') AND next_attempt_at <= clock_timestamp()))
 FROM public.document_processing_jobs
$$;
CREATE FUNCTION public.admin_migration_history() RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN RETURN jsonb_build_object('present', false, 'rows', '[]'::jsonb); END IF;
  RETURN jsonb_build_object('present', true, 'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object('version', version, 'name', name, 'checksum', checksum) ORDER BY version) FROM public.schema_migrations), '[]'::jsonb));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_processing_queue_health(), public.admin_migration_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_processing_queue_health(), public.admin_migration_history() TO health_wallet_app;

INSERT INTO public.admin_role_permissions(role_name,permission)
SELECT r.name,p.permission FROM public.admin_roles r
CROSS JOIN (VALUES('admin.health.read'),('admin.audit.read')) AS p(permission);
-- Filtered audit search by time and by action.
CREATE INDEX admin_audit_time_idx ON public.admin_audit_events(occurred_at);
CREATE INDEX admin_audit_action_idx ON public.admin_audit_events(action,seq DESC);
