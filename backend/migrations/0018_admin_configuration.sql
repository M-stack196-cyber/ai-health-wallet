-- M13 Phase 5: versioned operational settings with a release-gate approval record, and versioned serious-rule
-- configurations that can never carry a clinical approval. History is append-only: no UPDATE or DELETE exists.
CREATE FUNCTION public.admin_record_append_only() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Admin configuration history is append-only.' USING ERRCODE = '42501';
END;
$$;

CREATE TABLE public.admin_setting_versions(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 setting_key TEXT NOT NULL CHECK(setting_key ~ '^[a-z]+(\.[a-z_]+){1,2}$' AND length(setting_key)<=64),
 version INTEGER NOT NULL CHECK(version>0),
 value JSONB NOT NULL CHECK(jsonb_typeof(value)='number'),
 requires_approval BOOLEAN NOT NULL,
 gate TEXT CHECK(gate ~ '^CFG-[0-9]{2}$'),
 proposed_by UUID NOT NULL REFERENCES public.admin_accounts(id),
 proposed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(setting_key,version),
 CHECK(requires_approval = (gate IS NOT NULL))
);
CREATE FUNCTION public.admin_setting_version_next() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1095260233, hashtext('admin_setting:' || NEW.setting_key));
  IF NEW.version <> COALESCE((SELECT max(version) FROM public.admin_setting_versions WHERE setting_key = NEW.setting_key), 0) + 1 THEN
    RAISE EXCEPTION 'Setting versions must be consecutive.' USING ERRCODE = '23514';
  END IF;
  NEW.id := gen_random_uuid(); NEW.proposed_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_setting_version_insert BEFORE INSERT ON public.admin_setting_versions
FOR EACH ROW EXECUTE FUNCTION public.admin_setting_version_next();
CREATE TRIGGER admin_setting_version_no_change BEFORE UPDATE OR DELETE ON public.admin_setting_versions
FOR EACH ROW EXECUTE FUNCTION public.admin_record_append_only();
CREATE TRIGGER admin_setting_version_no_truncate BEFORE TRUNCATE ON public.admin_setting_versions
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_record_append_only();

-- One recorded decision per gated version. An approval can never come from the admin who proposed the change.
CREATE TABLE public.admin_setting_decisions(
 version_id UUID PRIMARY KEY REFERENCES public.admin_setting_versions(id),
 decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
 decided_by UUID NOT NULL REFERENCES public.admin_accounts(id),
 reference TEXT NOT NULL CHECK(reference ~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{0,119}$'),
 decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION public.admin_setting_decision_check() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v public.admin_setting_versions;
BEGIN
  SELECT * INTO v FROM public.admin_setting_versions WHERE id = NEW.version_id;
  IF NOT FOUND OR NOT v.requires_approval THEN
    RAISE EXCEPTION 'Only release-gated setting versions take an approval decision.' USING ERRCODE = '23514';
  END IF;
  IF NEW.decision = 'approved' AND NEW.decided_by = v.proposed_by THEN
    RAISE EXCEPTION 'A change cannot be approved by the admin who proposed it.' USING ERRCODE = '42501';
  END IF;
  NEW.decided_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_setting_decision_insert BEFORE INSERT ON public.admin_setting_decisions
FOR EACH ROW EXECUTE FUNCTION public.admin_setting_decision_check();
CREATE TRIGGER admin_setting_decision_no_change BEFORE UPDATE OR DELETE ON public.admin_setting_decisions
FOR EACH ROW EXECUTE FUNCTION public.admin_record_append_only();
CREATE TRIGGER admin_setting_decision_no_truncate BEFORE TRUNCATE ON public.admin_setting_decisions
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_record_append_only();

-- The value a service may read: the newest version that is ungated or approved. Pending and rejected versions never take effect.
CREATE VIEW public.admin_setting_effective AS
 SELECT DISTINCT ON (v.setting_key) v.setting_key, v.version, v.value, v.id AS version_id
 FROM public.admin_setting_versions v
 WHERE NOT v.requires_approval OR EXISTS(SELECT 1 FROM public.admin_setting_decisions d WHERE d.version_id = v.id AND d.decision = 'approved')
 ORDER BY v.setting_key, v.version DESC;

-- Serious-rule configurations edited in the dashboard. They are inert records: clinical approval (CFG-06) is a fixed
-- value that no column grant, default or application path can change, and nothing here feeds guardian_serious_rules.
CREATE TABLE public.admin_serious_rule_versions(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 rule_id TEXT NOT NULL CHECK(rule_id ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 version INTEGER NOT NULL CHECK(version>0),
 definition JSONB NOT NULL CHECK(jsonb_typeof(definition)='object' AND octet_length(definition::text)<=4096),
 definition_sha256 TEXT NOT NULL CHECK(definition_sha256 ~ '^[a-f0-9]{64}$'),
 clinical_approval TEXT NOT NULL DEFAULT 'not_clinically_approved' CHECK(clinical_approval='not_clinically_approved'),
 created_by UUID NOT NULL REFERENCES public.admin_accounts(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(rule_id,version)
);
CREATE FUNCTION public.admin_rule_version_next() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1095260233, hashtext('admin_rule:' || NEW.rule_id));
  IF NEW.version <> COALESCE((SELECT max(version) FROM public.admin_serious_rule_versions WHERE rule_id = NEW.rule_id), 0) + 1 THEN
    RAISE EXCEPTION 'Rule versions must be consecutive.' USING ERRCODE = '23514';
  END IF;
  NEW.id := gen_random_uuid(); NEW.created_at := clock_timestamp();
  NEW.definition_sha256 := encode(sha256(convert_to(NEW.definition::text,'UTF8')),'hex');
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_rule_version_insert BEFORE INSERT ON public.admin_serious_rule_versions
FOR EACH ROW EXECUTE FUNCTION public.admin_rule_version_next();
CREATE TRIGGER admin_rule_version_no_change BEFORE UPDATE OR DELETE ON public.admin_serious_rule_versions
FOR EACH ROW EXECUTE FUNCTION public.admin_record_append_only();
CREATE TRIGGER admin_rule_version_no_truncate BEFORE TRUNCATE ON public.admin_serious_rule_versions
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_record_append_only();

REVOKE ALL ON TABLE public.admin_setting_versions, public.admin_setting_decisions, public.admin_serious_rule_versions, public.admin_setting_effective FROM PUBLIC, health_wallet_app;
GRANT SELECT ON TABLE public.admin_setting_versions, public.admin_setting_decisions, public.admin_serious_rule_versions, public.admin_setting_effective TO health_wallet_app;
GRANT INSERT(setting_key,version,value,requires_approval,gate,proposed_by) ON TABLE public.admin_setting_versions TO health_wallet_app;
GRANT INSERT(version_id,decision,decided_by,reference) ON TABLE public.admin_setting_decisions TO health_wallet_app;
GRANT INSERT(rule_id,version,definition,created_by) ON TABLE public.admin_serious_rule_versions TO health_wallet_app;

INSERT INTO public.admin_role_permissions(role_name,permission)
SELECT r.name,p.permission FROM public.admin_roles r
CROSS JOIN (VALUES('admin.settings.read'),('admin.settings.change'),('admin.settings.approve'),('admin.rules.read'),('admin.rules.create')) AS p(permission);
CREATE INDEX admin_serious_rule_list_idx ON public.admin_serious_rule_versions(created_at DESC,id DESC);
