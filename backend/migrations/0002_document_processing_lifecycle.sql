-- Operational lifecycle metadata only. Originals/extraction/clinical tables stay intact.
CREATE TABLE public.document_processing_jobs (
  document_id UUID PRIMARY KEY,
  patient_id UUID NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','retry_wait','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  attempt_deadline_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IN ('PROCESSOR_FAILED','PROCESSOR_TIMEOUT','INTERRUPTED','INVALID_INPUT','LEASE_EXPIRED')),
  FOREIGN KEY (document_id,patient_id) REFERENCES public.medical_documents(id,patient_id) ON DELETE CASCADE,
  CONSTRAINT processing_attempt_bounds CHECK (attempt_count BETWEEN 0 AND max_attempts),
  CONSTRAINT processing_lease_shape CHECK (
    (state = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND attempt_deadline_at IS NOT NULL AND started_at IS NOT NULL AND finished_at IS NULL
      AND attempt_count > 0 AND lease_expires_at <= attempt_deadline_at)
    OR (state <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL AND attempt_deadline_at IS NULL)
  ),
  CONSTRAINT processing_state_shape CHECK (
    (state='pending' AND attempt_count=0 AND started_at IS NULL AND finished_at IS NULL AND last_error_code IS NULL)
    OR (state='running')
    OR (state='retry_wait' AND attempt_count>0 AND attempt_count<max_attempts AND finished_at IS NOT NULL AND last_error_code IS NOT NULL)
    OR (state='failed' AND attempt_count>0 AND finished_at IS NOT NULL AND last_error_code IS NOT NULL)
    OR (state='completed' AND attempt_count>0 AND finished_at IS NOT NULL AND last_error_code IS NULL)
  )
);
CREATE INDEX document_processing_owner_idx ON public.document_processing_jobs(document_id,patient_id);
CREATE INDEX document_processing_patient_idx ON public.document_processing_jobs(patient_id,document_id);
CREATE INDEX document_processing_ready_idx ON public.document_processing_jobs(next_attempt_at,created_at,document_id)
  WHERE state IN ('pending','retry_wait');
CREATE INDEX document_processing_expired_idx ON public.document_processing_jobs(lease_expires_at,document_id)
  WHERE state='running';

CREATE FUNCTION public.preserve_processing_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Processing ownership is immutable';
  END IF;
  NEW.updated_at=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER processing_owner_immutable BEFORE UPDATE ON public.document_processing_jobs
  FOR EACH ROW EXECUTE FUNCTION public.preserve_processing_owner();

CREATE FUNCTION public.enqueue_document_processing() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.processing_status='processing' THEN
    INSERT INTO public.document_processing_jobs(document_id,patient_id) VALUES(NEW.id,NEW.patient_id);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_processing_enqueue AFTER INSERT ON public.medical_documents
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_document_processing();

-- Existing pending originals acquire jobs without changing their public state or original.
INSERT INTO public.document_processing_jobs(document_id,patient_id)
  SELECT id,patient_id FROM public.medical_documents WHERE processing_status='processing';

REVOKE ALL ON public.document_processing_jobs FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.document_processing_jobs TO health_wallet_app;
REVOKE ALL ON FUNCTION public.preserve_processing_owner(), public.enqueue_document_processing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preserve_processing_owner(), public.enqueue_document_processing() TO health_wallet_app;
