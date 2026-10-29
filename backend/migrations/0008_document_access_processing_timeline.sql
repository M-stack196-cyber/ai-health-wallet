-- Policy-safe technical restriction only. No legal retention approval or object erasure.
ALTER TABLE public.medical_documents
 ADD COLUMN access_state TEXT NOT NULL DEFAULT 'active' CHECK(access_state IN ('active','restricted','deleted')),
 ADD COLUMN deleted_at TIMESTAMPTZ,
 ADD COLUMN suggested_document_date DATE,
 ADD COLUMN suggested_date_confidence NUMERIC CHECK(suggested_date_confidence BETWEEN 0 AND 100),
 ADD CONSTRAINT document_deletion_shape CHECK((access_state='deleted')=(deleted_at IS NOT NULL)),
 ADD CONSTRAINT document_date_suggestion_shape CHECK((suggested_document_date IS NULL)=(suggested_date_confidence IS NULL));
CREATE INDEX document_accessible_timeline ON public.medical_documents(patient_id,document_date DESC,uploaded_at DESC,id) WHERE access_state='active';
CREATE TABLE public.document_access_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),document_id UUID NOT NULL,patient_id UUID NOT NULL,
 event TEXT NOT NULL CHECK(event='deleted_retention_pending'),occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(document_id,event),FOREIGN KEY(document_id,patient_id) REFERENCES public.medical_documents(id,patient_id)
);
CREATE FUNCTION public.document_accessible(doc UUID,patient UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.medical_documents d JOIN public.patients p ON p.id=d.patient_id
 WHERE d.id=doc AND d.patient_id=patient AND d.access_state='active' AND p.account_status='active' AND p.email_verified_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION public.document_accessible(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.document_accessible(UUID,UUID) TO health_wallet_app;
ALTER TABLE public.medical_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_current_access ON public.medical_documents TO health_wallet_app
 USING(access_state='active' AND EXISTS(SELECT 1 FROM public.patients p WHERE p.id=medical_documents.patient_id AND p.account_status='active' AND p.email_verified_at IS NOT NULL)) WITH CHECK(access_state='active' AND deleted_at IS NULL AND EXISTS(
 SELECT 1 FROM public.patients p WHERE p.id=medical_documents.patient_id AND p.account_status='active' AND p.email_verified_at IS NOT NULL));
REVOKE DELETE ON public.medical_documents FROM health_wallet_app;
CREATE FUNCTION public.preserve_document_access_state() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.access_state='deleted' AND (NEW.access_state,NEW.deleted_at) IS DISTINCT FROM (OLD.access_state,OLD.deleted_at) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Deleted document access cannot be restored';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER document_access_immutable BEFORE UPDATE ON public.medical_documents FOR EACH ROW EXECUTE FUNCTION public.preserve_document_access_state();
ALTER TABLE public.document_processing_jobs DROP CONSTRAINT document_processing_jobs_state_check;
ALTER TABLE public.document_processing_jobs ADD CONSTRAINT document_processing_jobs_state_check CHECK(state IN ('pending','running','retry_wait','completed','failed','cancelled'));
ALTER TABLE public.document_processing_jobs DROP CONSTRAINT processing_state_shape;
ALTER TABLE public.document_processing_jobs ADD CONSTRAINT processing_state_shape CHECK(
 (state='pending' AND attempt_count=0 AND started_at IS NULL AND finished_at IS NULL AND last_error_code IS NULL)
 OR state='running'
 OR (state='retry_wait' AND attempt_count>0 AND attempt_count<max_attempts AND finished_at IS NOT NULL AND last_error_code IS NOT NULL)
 OR (state='failed' AND attempt_count>0 AND finished_at IS NOT NULL AND last_error_code IS NOT NULL)
 OR (state='completed' AND attempt_count>0 AND finished_at IS NOT NULL AND last_error_code IS NULL)
 OR (state='cancelled' AND finished_at IS NOT NULL AND last_error_code='INTERRUPTED'));

-- Structured run evidence is additive to the existing fenced extraction row.
CREATE TABLE public.document_processing_results (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),document_id UUID NOT NULL,patient_id UUID NOT NULL,
 request_id UUID NOT NULL UNIQUE,attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 5),lease_token UUID NOT NULL,
 source_sha256 TEXT NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),contract_version INTEGER NOT NULL CHECK(contract_version=1),
 structured_content JSONB NOT NULL CHECK(jsonb_typeof(structured_content)='object' AND octet_length(structured_content::text)<=4194304
  AND structured_content->>'content_trust'='untrusted_document_data' AND jsonb_typeof(structured_content->'pages')='array'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),UNIQUE(document_id,attempt),
 FOREIGN KEY(document_id,patient_id) REFERENCES public.medical_documents(id,patient_id)
);
CREATE INDEX processing_result_owner ON public.document_processing_results(document_id,patient_id);
CREATE FUNCTION public.guard_document_artifact() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT public.document_accessible(NEW.document_id,NEW.patient_id) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Document access is restricted';
 END IF;
 IF TG_TABLE_NAME='document_processing_results' THEN
 IF NOT EXISTS(SELECT 1 FROM public.document_processing_jobs j
 JOIN public.medical_documents d ON (d.id,d.patient_id)=(j.document_id,j.patient_id)
 WHERE j.document_id=NEW.document_id AND j.patient_id=NEW.patient_id AND j.state='running'
 AND j.lease_token=NEW.lease_token AND j.attempt_count=NEW.attempt AND j.lease_expires_at>clock_timestamp()
 AND j.attempt_deadline_at>clock_timestamp() AND d.sha256=NEW.source_sha256) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Processing evidence is stale';
 END IF;
 END IF;
 RETURN NEW;
END; $$;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['extracted_medical_text','medical_document_chunks','ai_report_summaries','sharing_grant_documents',
 'guardian_notification_events','serious_finding_evaluations','rag_interaction_sources','summary_source_snapshots','medical_summary_jobs',
 'document_processing_jobs','document_processing_results'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY artifact_current_access ON public.%I TO health_wallet_app USING(public.document_accessible(document_id,patient_id)) WITH CHECK(public.document_accessible(document_id,patient_id))',t);
  EXECUTE format('CREATE TRIGGER artifact_access_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.guard_document_artifact()',t);
 END LOOP;
END; $$;
CREATE FUNCTION public.rag_sources_accessible(interaction UUID,patient UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.rag_interaction_sources s WHERE s.interaction_id=interaction AND s.patient_id=patient)
 AND NOT EXISTS(SELECT 1 FROM public.rag_interaction_sources s WHERE s.interaction_id=interaction AND s.patient_id=patient
 AND NOT public.document_accessible(s.document_id,s.patient_id))
$$;
ALTER TABLE public.rag_interactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rag_current_sources ON public.rag_interactions FOR SELECT TO health_wallet_app USING(public.rag_sources_accessible(id,patient_id));
-- No new RAG producer is authorized; its future migration must define its write policy.

CREATE FUNCTION public.restrict_patient_document(doc UUID,patient UUID,session UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d public.medical_documents%ROWTYPE;
BEGIN
 PERFORM 1 FROM public.patients WHERE id=patient FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.patient_auth_sessions s JOIN public.patients p ON p.id=s.patient_id
 WHERE s.id=session AND s.patient_id=patient AND p.account_status='active' AND p.email_verified_at IS NOT NULL
 AND s.security_version=p.security_version AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.idle_expires_at>clock_timestamp()) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Current patient authorization required';
 END IF;
 -- Same order as extraction publication: job before document, then derived artifacts.
 PERFORM 1 FROM public.document_processing_jobs WHERE document_id=doc AND patient_id=patient FOR UPDATE;
 SELECT * INTO d FROM public.medical_documents WHERE id=doc AND patient_id=patient FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF d.access_state='deleted' THEN RETURN true; END IF;
 UPDATE public.document_processing_jobs SET state='cancelled',finished_at=clock_timestamp(),last_error_code='INTERRUPTED',
 lease_token=NULL,lease_expires_at=NULL,attempt_deadline_at=NULL WHERE document_id=doc AND patient_id=patient AND state NOT IN ('completed','cancelled');
 UPDATE public.doctor_sharing_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE patient_id=patient AND id IN(
 SELECT grant_id FROM public.sharing_grant_documents WHERE document_id=doc AND patient_id=patient);
 UPDATE public.guardian_notification_events SET delivery_status='failed',failure_code='DOCUMENT_DELETED' WHERE document_id=doc AND patient_id=patient AND delivery_status<>'sent';
 UPDATE public.medical_documents SET access_state='deleted',deleted_at=clock_timestamp() WHERE id=doc AND patient_id=patient;
 INSERT INTO public.document_access_events(document_id,patient_id,event) VALUES(doc,patient,'deleted_retention_pending');
 RETURN true;
END; $$;
REVOKE ALL ON public.document_access_events,public.document_processing_results FROM PUBLIC;
GRANT SELECT ON public.document_access_events TO health_wallet_app;
GRANT SELECT,INSERT ON public.document_processing_results TO health_wallet_app;
REVOKE ALL ON FUNCTION public.preserve_document_access_state(),public.guard_document_artifact(),public.rag_sources_accessible(UUID,UUID),public.restrict_patient_document(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preserve_document_access_state(),public.guard_document_artifact(),public.rag_sources_accessible(UUID,UUID),public.restrict_patient_document(UUID,UUID,UUID) TO health_wallet_app;

CREATE FUNCTION public.persist_python_document_result(doc UUID,patient UUID,token UUID,request UUID,attempt_no INTEGER,body TEXT,meta JSONB,version TEXT,structured JSONB,suggested DATE,confidence NUMERIC)
RETURNS BOOLEAN LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE j public.document_processing_jobs%ROWTYPE;
BEGIN
 SELECT * INTO j FROM public.document_processing_jobs WHERE document_id=doc AND patient_id=patient FOR UPDATE;
 IF NOT FOUND OR j.state<>'running' OR j.lease_token IS DISTINCT FROM token OR j.attempt_count<>attempt_no
 OR j.lease_expires_at<=clock_timestamp() OR j.attempt_deadline_at<=clock_timestamp() OR NOT public.document_accessible(doc,patient) THEN RETURN false; END IF;
 INSERT INTO public.document_processing_results(document_id,patient_id,request_id,attempt,lease_token,source_sha256,contract_version,structured_content)
 VALUES(doc,patient,request,attempt_no,token,meta#>>'{source,sha256}',1,structured);
 IF NOT public.persist_document_extraction(doc,patient,token,body,meta,version) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Processing claim expired'; END IF;
 UPDATE public.medical_documents SET suggested_document_date=suggested,suggested_date_confidence=confidence WHERE id=doc AND patient_id=patient;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.persist_python_document_result(UUID,UUID,UUID,UUID,INTEGER,TEXT,JSONB,TEXT,JSONB,DATE,NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.persist_python_document_result(UUID,UUID,UUID,UUID,INTEGER,TEXT,JSONB,TEXT,JSONB,DATE,NUMERIC) TO health_wallet_app;
