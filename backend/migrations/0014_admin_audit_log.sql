-- M13 Phase 1: append-only, hash-chained admin audit log. The API role can add and read events only;
-- sequence, time, identifier and hashes are assigned by the database, never by the application.
CREATE TABLE public.admin_audit_events(
 seq BIGINT PRIMARY KEY,
 id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 actor_admin_id UUID REFERENCES public.admin_accounts(id),
 actor_role TEXT REFERENCES public.admin_roles(name),
 action TEXT NOT NULL CHECK(action ~ '^[a-z]+(\.[a-z_]+){1,3}$' AND length(action)<=64),
 target_type TEXT NOT NULL CHECK(target_type ~ '^[a-z_]{1,40}$'),
 target_id TEXT CHECK(length(target_id)<=64),
 scope JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(scope)='object' AND octet_length(scope::text)<=2048),
 outcome TEXT NOT NULL CHECK(outcome IN ('success','denied','failure')),
 request_id UUID NOT NULL,
 prev_hash TEXT NOT NULL CHECK(prev_hash ~ '^[a-f0-9]{64}$'),
 event_hash TEXT NOT NULL UNIQUE CHECK(event_hash ~ '^[a-f0-9]{64}$'),
 CHECK((actor_admin_id IS NULL) = (actor_role IS NULL))
);
CREATE INDEX admin_audit_actor_time_idx ON public.admin_audit_events(actor_admin_id,occurred_at DESC);

CREATE FUNCTION public.admin_audit_digest(e public.admin_audit_events) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
 SELECT encode(sha256(convert_to(concat_ws('|',e.seq::text,e.id::text,
  to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'),COALESCE(e.actor_admin_id::text,''),COALESCE(e.actor_role,''),
  e.action,e.target_type,COALESCE(e.target_id,''),e.scope::text,e.outcome,e.request_id::text,e.prev_hash),'UTF8')),'hex');
$$;

CREATE FUNCTION public.admin_audit_chain() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE last_event public.admin_audit_events;
BEGIN
  -- One writer at a time keeps the chain linear. The lock is released with the caller's transaction.
  PERFORM pg_advisory_xact_lock(1095260232, 1409);
  SELECT * INTO last_event FROM public.admin_audit_events ORDER BY seq DESC LIMIT 1;
  NEW.seq := COALESCE(last_event.seq, 0) + 1;
  NEW.id := gen_random_uuid();
  NEW.occurred_at := clock_timestamp();
  NEW.prev_hash := COALESCE(last_event.event_hash, repeat('0',64));
  NEW.event_hash := public.admin_audit_digest(NEW);
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_audit_chain_insert BEFORE INSERT ON public.admin_audit_events
FOR EACH ROW EXECUTE FUNCTION public.admin_audit_chain();

CREATE FUNCTION public.admin_audit_append_only() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Admin audit events are append-only.' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER admin_audit_no_change BEFORE UPDATE OR DELETE ON public.admin_audit_events
FOR EACH ROW EXECUTE FUNCTION public.admin_audit_append_only();
CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON public.admin_audit_events
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_audit_append_only();

-- Returns the number of events checked and the first sequence that breaks the chain (NULL when intact).
CREATE FUNCTION public.verify_admin_audit_chain() RETURNS TABLE(checked BIGINT, first_invalid BIGINT)
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE e public.admin_audit_events; expected_prev TEXT := repeat('0',64); expected_seq BIGINT := 1;
BEGIN
  checked := 0; first_invalid := NULL;
  FOR e IN SELECT * FROM public.admin_audit_events ORDER BY seq LOOP
    IF e.seq <> expected_seq OR e.prev_hash <> expected_prev OR e.event_hash <> public.admin_audit_digest(e) THEN
      first_invalid := e.seq; RETURN NEXT; RETURN;
    END IF;
    checked := checked + 1; expected_prev := e.event_hash; expected_seq := e.seq + 1;
  END LOOP;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON TABLE public.admin_audit_events FROM PUBLIC, health_wallet_app;
GRANT SELECT ON TABLE public.admin_audit_events TO health_wallet_app;
GRANT INSERT(actor_admin_id,actor_role,action,target_type,target_id,scope,outcome,request_id)
  ON TABLE public.admin_audit_events TO health_wallet_app;
REVOKE ALL ON FUNCTION public.verify_admin_audit_chain() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_admin_audit_chain() TO health_wallet_app;
