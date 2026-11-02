-- M13 Phase 1: separate privileged admin identity and RBAC. Admins are never patients or doctors.
-- The API role may read accounts and manage sessions, but cannot create or alter admin accounts or roles.
CREATE TABLE public.admin_roles(
 name TEXT PRIMARY KEY CHECK(name IN ('support_admin','operations_admin','config_admin'))
);
INSERT INTO public.admin_roles(name) VALUES('support_admin'),('operations_admin'),('config_admin');
CREATE TABLE public.admin_role_permissions(
 role_name TEXT NOT NULL REFERENCES public.admin_roles(name),
 permission TEXT NOT NULL CHECK(permission ~ '^[a-z]+(\.[a-z_]+){1,3}$' AND length(permission)<=64),
 PRIMARY KEY(role_name,permission)
);
-- Phase 1 grants every role only its own profile read. Later phases add least-privilege permissions by migration.
INSERT INTO public.admin_role_permissions(role_name,permission) VALUES
 ('support_admin','admin.profile.read'),('operations_admin','admin.profile.read'),('config_admin','admin.profile.read');
CREATE TABLE public.admin_accounts(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 email TEXT NOT NULL UNIQUE CHECK(email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
 password_hash TEXT NOT NULL CHECK(left(password_hash,10)='$argon2id$'),
 full_name TEXT NOT NULL CHECK(length(btrim(full_name)) BETWEEN 1 AND 120),
 role_name TEXT NOT NULL REFERENCES public.admin_roles(name),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 security_version BIGINT NOT NULL DEFAULT 1 CHECK(security_version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.admin_sessions(
 id UUID PRIMARY KEY,
 admin_id UUID NOT NULL REFERENCES public.admin_accounts(id),
 security_version BIGINT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 CHECK(expires_at > created_at)
);
CREATE INDEX admin_sessions_owner_idx ON public.admin_sessions(admin_id,id);
CREATE TABLE public.admin_auth_rate_limits(
 bucket_hash TEXT PRIMARY KEY CHECK(bucket_hash ~ '^[a-f0-9]{64}$'),
 window_started_at TIMESTAMPTZ NOT NULL,
 attempts INTEGER NOT NULL CHECK(attempts > 0)
);

-- Any credential, role or status change invalidates previously issued admin sessions.
CREATE FUNCTION public.invalidate_admin_security_state() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.password_hash IS DISTINCT FROM OLD.password_hash
    OR NEW.role_name IS DISTINCT FROM OLD.role_name OR NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.security_version := OLD.security_version + 1;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_security_state_changed BEFORE UPDATE ON public.admin_accounts
FOR EACH ROW EXECUTE FUNCTION public.invalidate_admin_security_state();

REVOKE ALL ON TABLE public.admin_roles, public.admin_role_permissions, public.admin_accounts,
  public.admin_sessions, public.admin_auth_rate_limits FROM PUBLIC, health_wallet_app;
GRANT SELECT ON TABLE public.admin_roles, public.admin_role_permissions, public.admin_accounts TO health_wallet_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_sessions, public.admin_auth_rate_limits TO health_wallet_app;
