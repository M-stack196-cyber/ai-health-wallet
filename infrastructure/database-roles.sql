-- Run through npm run db:provision. Password placeholders receive SCRAM
-- verifiers over stdin, never command arguments. No plaintext password SQL.
-- Preflight validates the dedicated database, known object set and ownership.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(1095260232, 1400);

DO $$
BEGIN
  IF current_database() <> 'ai_health_wallet' OR current_user <> 'health_wallet_user' THEN
    RAISE EXCEPTION 'Provisioning requires the dedicated bootstrap identity/database';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'health_wallet_migrator') THEN
    CREATE ROLE health_wallet_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '__MIGRATOR_SCRAM__';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'health_wallet_app') THEN
    CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '__APP_SCRAM__';
  END IF;
END;
$$;

ALTER ROLE health_wallet_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE health_wallet_migrator IN DATABASE ai_health_wallet SET search_path = pg_catalog, public;
ALTER ROLE health_wallet_app IN DATABASE ai_health_wallet SET search_path = pg_catalog, public;

-- Bootstrap database ownership remains unchanged. No cross-database revocations.
REVOKE ALL ON DATABASE ai_health_wallet FROM PUBLIC, health_wallet_app, health_wallet_migrator;
GRANT CONNECT, TEMPORARY ON DATABASE ai_health_wallet TO health_wallet_migrator;
GRANT CONNECT ON DATABASE ai_health_wallet TO health_wallet_app;
ALTER SCHEMA public OWNER TO health_wallet_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC, health_wallet_app;
GRANT USAGE ON SCHEMA public TO health_wallet_app;

-- Explicit object transfers preserve table/index/function OIDs and all records.
ALTER TABLE public.patients OWNER TO health_wallet_migrator;
ALTER TABLE public.guardian_contacts OWNER TO health_wallet_migrator;
ALTER TABLE public.medical_documents OWNER TO health_wallet_migrator;
ALTER TABLE public.extracted_medical_text OWNER TO health_wallet_migrator;
ALTER TABLE public.medical_document_chunks OWNER TO health_wallet_migrator;
ALTER TABLE public.ai_report_summaries OWNER TO health_wallet_migrator;
ALTER TABLE public.doctor_sharing_grants OWNER TO health_wallet_migrator;
ALTER TABLE public.sharing_grant_documents OWNER TO health_wallet_migrator;
ALTER TABLE public.doctor_otp_challenges OWNER TO health_wallet_migrator;
ALTER TABLE public.guardian_notification_events OWNER TO health_wallet_migrator;
ALTER TABLE public.serious_finding_evaluations OWNER TO health_wallet_migrator;
ALTER TABLE public.rag_interactions OWNER TO health_wallet_migrator;
ALTER TABLE public.rag_interaction_sources OWNER TO health_wallet_migrator;
ALTER TABLE public.schema_migrations OWNER TO health_wallet_migrator;
ALTER FUNCTION public.enforce_rag_source_authorization() OWNER TO health_wallet_migrator;
ALTER FUNCTION public.preserve_rag_authorization() OWNER TO health_wallet_migrator;
ALTER FUNCTION public.set_updated_at() OWNER TO health_wallet_migrator;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, health_wallet_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, health_wallet_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, health_wallet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.patients, public.guardian_contacts, public.medical_documents,
  public.extracted_medical_text, public.medical_document_chunks, public.ai_report_summaries,
  public.doctor_sharing_grants, public.sharing_grant_documents, public.doctor_otp_challenges,
  public.guardian_notification_events, public.serious_finding_evaluations,
  public.rag_interactions, public.rag_interaction_sources
TO health_wallet_app;
GRANT EXECUTE ON FUNCTION public.enforce_rag_source_authorization(),
  public.preserve_rag_authorization(), public.set_updated_at() TO health_wallet_app;

-- Deny by default for future migration-owned objects. A later migration must
-- explicitly grant approved table CRUD, sequence USAGE or function EXECUTE.
-- Global defaults are scoped to this database, not the PostgreSQL cluster.
ALTER DEFAULT PRIVILEGES FOR ROLE health_wallet_migrator REVOKE ALL ON TABLES FROM PUBLIC, health_wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE health_wallet_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, health_wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE health_wallet_migrator REVOKE ALL ON SEQUENCES FROM PUBLIC, health_wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE health_wallet_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, health_wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE health_wallet_migrator REVOKE ALL ON FUNCTIONS FROM PUBLIC, health_wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE health_wallet_migrator IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC, health_wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE health_wallet_migrator REVOKE ALL ON TYPES FROM PUBLIC, health_wallet_app;
ALTER DEFAULT PRIVILEGES FOR ROLE health_wallet_migrator IN SCHEMA public REVOKE ALL ON TYPES FROM PUBLIC, health_wallet_app;
COMMIT;
