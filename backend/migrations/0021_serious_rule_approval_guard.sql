-- M07/M13 Phase R6 (CFG-06): the application role (API, workers, Admin routes) can record only non-clinical demo
-- rules. A clinical approval row can never be created through the application, whatever metadata it carries.
-- Recording a real approval remains a separate, owner-controlled, evidenced step that is not built here.
CREATE FUNCTION public.guard_serious_rule_approval() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.approval_status <> 'non_clinical_demo' AND current_user = 'health_wallet_app' THEN
    RAISE EXCEPTION 'clinical approval cannot be recorded by the application role' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guardian_serious_rule_approval_guard BEFORE INSERT ON public.guardian_serious_rules
FOR EACH ROW EXECUTE FUNCTION public.guard_serious_rule_approval();
REVOKE ALL ON FUNCTION public.guard_serious_rule_approval() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guard_serious_rule_approval() TO health_wallet_app;
