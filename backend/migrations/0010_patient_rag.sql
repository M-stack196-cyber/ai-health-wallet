-- pgvector is an explicit DBA prerequisite, never installed into a live DB here.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='vector') THEN RAISE EXCEPTION 'pgvector extension prerequisite is not satisfied'; END IF; END $$;
ALTER TABLE public.medical_document_chunks
 ADD COLUMN snapshot_id UUID,
 ADD COLUMN source_fingerprint TEXT,
 ADD COLUMN chunker_version TEXT,
 ADD COLUMN start_byte INTEGER,
 ADD COLUMN end_byte INTEGER,
 ADD COLUMN page INTEGER CHECK(page>0),
 ADD CONSTRAINT chunk_identity UNIQUE(id,document_id,patient_id),
 ADD CONSTRAINT chunk_source_identity FOREIGN KEY(snapshot_id,document_id,patient_id) REFERENCES public.summary_source_snapshots(id,document_id,patient_id),
 ADD CONSTRAINT chunk_trace_shape CHECK((snapshot_id IS NULL AND source_fingerprint IS NULL AND chunker_version IS NULL AND start_byte IS NULL AND end_byte IS NULL)
 OR (snapshot_id IS NOT NULL AND source_fingerprint ~ '^[a-f0-9]{64}$' AND chunker_version IS NOT NULL AND start_byte>=0 AND end_byte>start_byte));
CREATE TABLE public.rag_embedding_models(
 model_key TEXT PRIMARY KEY,provider TEXT NOT NULL,model TEXT NOT NULL,revision TEXT NOT NULL,
 dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 8 AND 2048),approval_state TEXT NOT NULL CHECK(approval_state='candidate'),
 UNIQUE(model_key,dimensions)
);
-- Development candidate only, not a CFG-02 approved selection.
INSERT INTO public.rag_embedding_models VALUES('synthetic-hash-32-v1','local-synthetic','hash-token','1',32,'candidate');
CREATE TABLE public.rag_chunk_embeddings(
 chunk_id UUID NOT NULL,document_id UUID NOT NULL,patient_id UUID NOT NULL,
 snapshot_id UUID NOT NULL,source_fingerprint TEXT NOT NULL,
 model_key TEXT NOT NULL,dimensions INTEGER NOT NULL,embedding public.vector NOT NULL,
 generated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(chunk_id,model_key),
 FOREIGN KEY(chunk_id,document_id,patient_id) REFERENCES public.medical_document_chunks(id,document_id,patient_id),
 FOREIGN KEY(snapshot_id,document_id,patient_id) REFERENCES public.summary_source_snapshots(id,document_id,patient_id),
 FOREIGN KEY(model_key,dimensions) REFERENCES public.rag_embedding_models(model_key,dimensions),
 CHECK(public.vector_dims(embedding)=dimensions AND public.vector_norm(embedding)>0)
);
CREATE INDEX rag_vector_patient_model ON public.rag_chunk_embeddings(patient_id,model_key,document_id);
CREATE FUNCTION public.rag_chunk_current(chunk UUID,patient UUID,snapshot UUID,fingerprint TEXT) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.medical_document_chunks c JOIN public.summary_source_snapshots s ON (s.id,s.document_id,s.patient_id)=(c.snapshot_id,c.document_id,c.patient_id)
 WHERE c.id=chunk AND c.patient_id=patient AND c.snapshot_id=snapshot AND c.source_fingerprint=fingerprint
 AND s.source_fingerprint=fingerprint AND public.document_accessible(c.document_id,patient) AND public.summary_source_current(s))
$$;
ALTER TABLE public.rag_chunk_embeddings ENABLE ROW LEVEL SECURITY;
CREATE POLICY rag_vector_scope ON public.rag_chunk_embeddings TO health_wallet_app
 USING(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND public.rag_chunk_current(chunk_id,patient_id,snapshot_id,source_fingerprint))
 WITH CHECK(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND public.rag_chunk_current(chunk_id,patient_id,snapshot_id,source_fingerprint));
CREATE FUNCTION public.rag_clear_embeddings(doc UUID,patient UUID,snapshot UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF patient IS DISTINCT FROM NULLIF(current_setting('app.rag_patient_id',true),'')::uuid OR NOT public.document_accessible(doc,patient)
 OR NOT EXISTS(SELECT 1 FROM public.summary_source_snapshots s WHERE (s.id,s.document_id,s.patient_id)=(snapshot,doc,patient) AND public.lock_summary_source(s)) THEN
 RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='RAG source authorization required'; END IF;
 DELETE FROM public.rag_chunk_embeddings WHERE document_id=doc AND patient_id=patient;
END $$;
ALTER TABLE public.rag_interactions ADD COLUMN rag_contract_version INTEGER CHECK(rag_contract_version=1),
 ADD COLUMN result_status TEXT CHECK(result_status IN ('answered','insufficient')),
 ADD COLUMN structured_answer JSONB,
 ADD COLUMN provenance JSONB,
 ADD CONSTRAINT rag_result_shape CHECK(rag_contract_version IS NULL OR
 (sharing_grant_id IS NULL AND result_status IS NOT NULL AND answer IS NOT NULL AND structured_answer IS NOT NULL AND provenance IS NOT NULL AND octet_length(structured_answer::text)<=131072));
CREATE TABLE public.rag_answer_evidence(
 interaction_id UUID NOT NULL,patient_id UUID NOT NULL,document_id UUID NOT NULL,chunk_id UUID NOT NULL,
 snapshot_id UUID NOT NULL,source_fingerprint TEXT NOT NULL,citation_id TEXT NOT NULL CHECK(citation_id ~ '^C[1-9][0-9]*$'),
 quote TEXT NOT NULL CHECK(octet_length(quote) BETWEEN 1 AND 4096),PRIMARY KEY(interaction_id,citation_id),
 FOREIGN KEY(interaction_id,patient_id) REFERENCES public.rag_interactions(id,patient_id),
 FOREIGN KEY(chunk_id,document_id,patient_id) REFERENCES public.medical_document_chunks(id,document_id,patient_id),
 FOREIGN KEY(snapshot_id,document_id,patient_id) REFERENCES public.summary_source_snapshots(id,document_id,patient_id)
);
CREATE INDEX rag_evidence_source ON public.rag_answer_evidence(document_id,patient_id,interaction_id);
ALTER TABLE public.rag_answer_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY rag_evidence_scope ON public.rag_answer_evidence TO health_wallet_app
 USING(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND public.rag_chunk_current(chunk_id,patient_id,snapshot_id,source_fingerprint))
 WITH CHECK(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND public.rag_chunk_current(chunk_id,patient_id,snapshot_id,source_fingerprint));
CREATE OR REPLACE FUNCTION public.rag_sources_accessible(interaction UUID,patient UUID) RETURNS BOOLEAN
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM public.rag_interactions r WHERE r.id=interaction AND r.patient_id=patient AND r.rag_contract_version=1)
 THEN EXISTS(SELECT 1 FROM public.rag_answer_evidence e WHERE e.interaction_id=interaction AND e.patient_id=patient)
 AND NOT EXISTS(SELECT 1 FROM public.rag_answer_evidence e WHERE e.interaction_id=interaction AND e.patient_id=patient AND NOT public.rag_chunk_current(e.chunk_id,patient,e.snapshot_id,e.source_fingerprint))
 ELSE EXISTS(SELECT 1 FROM public.rag_interaction_sources s WHERE s.interaction_id=interaction AND s.patient_id=patient)
 AND NOT EXISTS(SELECT 1 FROM public.rag_interaction_sources s WHERE s.interaction_id=interaction AND s.patient_id=patient AND NOT public.document_accessible(s.document_id,patient)) END
$$;
CREATE POLICY rag_patient_insert ON public.rag_interactions FOR INSERT TO health_wallet_app
 WITH CHECK(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND rag_contract_version=1 AND sharing_grant_id IS NULL
 AND EXISTS(SELECT 1 FROM public.patients p WHERE p.id=patient_id AND p.account_status='active' AND p.email_verified_at IS NOT NULL));
CREATE POLICY rag_empty_result ON public.rag_interactions FOR SELECT TO health_wallet_app
 USING(patient_id=NULLIF(current_setting('app.rag_patient_id',true),'')::uuid AND rag_contract_version=1 AND result_status='insufficient'
 AND EXISTS(SELECT 1 FROM public.patients p WHERE p.id=patient_id AND p.account_status='active' AND p.email_verified_at IS NOT NULL));
CREATE FUNCTION public.confirm_rag_result() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.rag_contract_version=1 AND NEW.result_status='answered' AND (
 NOT public.rag_sources_accessible(NEW.id,NEW.patient_id) OR EXISTS(
 SELECT 1 FROM public.rag_answer_evidence e WHERE e.interaction_id=NEW.id AND e.patient_id=NEW.patient_id AND NOT EXISTS(
 SELECT 1 FROM public.rag_interaction_sources s WHERE (s.interaction_id,s.document_id,s.patient_id)=(e.interaction_id,e.document_id,e.patient_id)))) THEN
 RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='RAG source publication refused'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rag_atomic_result AFTER INSERT ON public.rag_interactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.confirm_rag_result();
REVOKE ALL ON public.rag_embedding_models,public.rag_chunk_embeddings,public.rag_answer_evidence FROM PUBLIC,health_wallet_app;
GRANT SELECT ON public.rag_embedding_models TO health_wallet_app;
GRANT SELECT,INSERT,DELETE ON public.rag_chunk_embeddings TO health_wallet_app;
GRANT SELECT,INSERT ON public.rag_answer_evidence TO health_wallet_app;
REVOKE UPDATE,DELETE ON public.rag_interactions FROM health_wallet_app;
REVOKE ALL ON FUNCTION public.rag_chunk_current(UUID,UUID,UUID,TEXT),public.rag_clear_embeddings(UUID,UUID,UUID),public.confirm_rag_result() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rag_chunk_current(UUID,UUID,UUID,TEXT),public.rag_clear_embeddings(UUID,UUID,UUID),public.confirm_rag_result() TO health_wallet_app;

-- The existing FK authorization trigger takes a row lock. Execute it as its
-- owner rather than granting the API role UPDATE on immutable RAG answers.
CREATE OR REPLACE FUNCTION public.enforce_rag_source_authorization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE expected_grant UUID;
BEGIN
  SELECT sharing_grant_id INTO expected_grant FROM public.rag_interactions
    WHERE id = NEW.interaction_id AND patient_id = NEW.patient_id FOR SHARE;
  IF NOT FOUND OR NEW.sharing_grant_id IS DISTINCT FROM expected_grant THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'RAG source authorization does not match interaction';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_rag_source_authorization() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_rag_source_authorization() TO health_wallet_app;
