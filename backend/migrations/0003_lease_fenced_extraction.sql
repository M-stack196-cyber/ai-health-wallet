-- Preserve existing extraction rows; legacy NULL associations are read-only
-- until explicitly replaced by a valid current processing attempt.
ALTER TABLE public.extracted_medical_text
  ADD COLUMN processing_attempt INTEGER,
  ADD COLUMN processing_claim_token UUID,
  ADD CONSTRAINT extraction_attempt_pair CHECK (
    (processing_attempt IS NULL AND processing_claim_token IS NULL)
    OR (processing_attempt BETWEEN 1 AND 5 AND processing_claim_token IS NOT NULL)
  );

CREATE FUNCTION public.valid_extraction_payload(body TEXT,meta JSONB,version TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE page JSONB; position INTEGER:=0; count_pages INTEGER; seen_pdf BOOLEAN:=false; seen_ocr BOOLEAN:=false;
BEGIN
  IF body IS NULL OR char_length(body)>1000000 OR octet_length(body)>4194304
    OR body !~ '[^[:space:]]' OR regexp_replace(body,E'[\t\n\r]','','g') ~ '[[:cntrl:]]'
    OR meta IS NULL OR jsonb_typeof(meta)<>'object' OR octet_length(meta::text)>16384
    OR version IS NULL OR version !~ '^[A-Za-z0-9][A-Za-z0-9.+_:/ -]{0,127}$' THEN RETURN false; END IF;
  IF NOT(meta ?& ARRAY['schemaVersion','method','extractor','source'])
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(meta) k WHERE k<>ALL(ARRAY['schemaVersion','method','extractor','source']))
    OR meta->'schemaVersion'<>'1'::jsonb OR jsonb_typeof(meta->'method')<>'string' OR meta->>'method' NOT IN ('pdf_text','ocr','mixed')
    OR jsonb_typeof(meta->'extractor')<>'object' OR jsonb_typeof(meta->'source')<>'object' THEN RETURN false; END IF;
  IF NOT(meta->'extractor' ?& ARRAY['name','version'])
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(meta->'extractor') k WHERE k<>ALL(ARRAY['name','version']))
    OR jsonb_typeof(meta#>'{extractor,name}')<>'string'
    OR meta#>>'{extractor,name}' !~ '^[A-Za-z0-9][A-Za-z0-9.+_:/ -]{0,63}$'
    OR jsonb_typeof(meta#>'{extractor,version}')<>'string' OR meta#>>'{extractor,version}' IS DISTINCT FROM version
    OR NOT(meta->'source' ?& ARRAY['sha256','pageCount','pages'])
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(meta->'source') k WHERE k<>ALL(ARRAY['sha256','pageCount','pages']))
    OR jsonb_typeof(meta#>'{source,sha256}')<>'string' OR meta#>>'{source,sha256}' !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(meta#>'{source,pageCount}')<>'number' OR meta#>>'{source,pageCount}' !~ '^[1-9][0-9]{0,2}$'
    OR jsonb_typeof(meta#>'{source,pages}')<>'array' THEN RETURN false; END IF;
  count_pages:=(meta#>>'{source,pageCount}')::integer;
  IF count_pages>200 OR jsonb_array_length(meta#>'{source,pages}')<>count_pages THEN RETURN false; END IF;
  FOR page IN SELECT value FROM jsonb_array_elements(meta#>'{source,pages}') LOOP
    position:=position+1;
    IF jsonb_typeof(page)<>'object' THEN RETURN false; END IF;
    IF NOT(page ?& ARRAY['page','method'])
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(page) k WHERE k<>ALL(ARRAY['page','method','confidence']))
      OR page->'page' IS DISTINCT FROM to_jsonb(position) OR jsonb_typeof(page->'method')<>'string' OR page->>'method' NOT IN ('pdf_text','ocr') THEN RETURN false; END IF;
    IF page ? 'confidence' THEN
      IF page->>'method'<>'ocr' OR jsonb_typeof(page->'confidence')<>'number' THEN RETURN false; END IF;
      IF (page->>'confidence')::numeric<0 OR (page->>'confidence')::numeric>100 THEN RETURN false; END IF;
    END IF;
    seen_pdf:=seen_pdf OR page->>'method'='pdf_text';seen_ocr:=seen_ocr OR page->>'method'='ocr';
  END LOOP;
  RETURN CASE meta->>'method' WHEN 'mixed' THEN seen_pdf AND seen_ocr WHEN 'pdf_text' THEN seen_pdf AND NOT seen_ocr ELSE seen_ocr AND NOT seen_pdf END;
END;
$$;

CREATE FUNCTION public.fence_extraction_write() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE job public.document_processing_jobs%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Extraction identity is immutable';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.medical_documents WHERE id=NEW.document_id AND patient_id=NEW.patient_id) THEN
    RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Extraction ownership mismatch';
  END IF;
  IF NEW.processing_status<>'completed' OR NEW.processing_attempt IS NULL OR NEW.processing_claim_token IS NULL
    OR public.valid_extraction_payload(NEW.extracted_text,NEW.source_metadata,NEW.extractor_version) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid extraction evidence';
  END IF;
  SELECT * INTO job FROM public.document_processing_jobs WHERE document_id=NEW.document_id AND patient_id=NEW.patient_id FOR UPDATE;
  IF NOT FOUND OR job.state<>'running' OR job.lease_token IS DISTINCT FROM NEW.processing_claim_token
    OR job.attempt_count IS DISTINCT FROM NEW.processing_attempt OR job.lease_expires_at<=clock_timestamp()
    OR job.attempt_deadline_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Extraction claim is no longer valid';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER extraction_write_fence BEFORE INSERT OR UPDATE ON public.extracted_medical_text
  FOR EACH ROW EXECUTE FUNCTION public.fence_extraction_write();

CREATE FUNCTION public.fence_extraction_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.state='completed' AND OLD.state<>'completed' THEN
    IF OLD.state<>'running' OR OLD.lease_expires_at<=clock_timestamp() OR OLD.attempt_deadline_at<=clock_timestamp()
      OR NOT EXISTS(SELECT 1 FROM public.extracted_medical_text e WHERE e.document_id=OLD.document_id AND e.patient_id=OLD.patient_id
        AND e.processing_status='completed' AND e.processing_attempt=OLD.attempt_count
        AND e.processing_claim_token=OLD.lease_token AND public.valid_extraction_payload(e.extracted_text,e.source_metadata,e.extractor_version) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Current extraction evidence is required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER extraction_completion_fence BEFORE UPDATE ON public.document_processing_jobs
  FOR EACH ROW EXECUTE FUNCTION public.fence_extraction_completion();

CREATE FUNCTION public.persist_document_extraction(doc UUID,patient UUID,token UUID,body TEXT,meta JSONB,version TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE job public.document_processing_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job FROM public.document_processing_jobs WHERE document_id=doc AND patient_id=patient FOR UPDATE;
  IF NOT FOUND OR job.state<>'running' OR job.lease_token IS DISTINCT FROM token
    OR job.lease_expires_at<=clock_timestamp() OR job.attempt_deadline_at<=clock_timestamp() THEN RETURN false; END IF;
  IF public.valid_extraction_payload(body,meta,version) IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid extraction evidence';
  END IF;
  INSERT INTO public.extracted_medical_text(document_id,patient_id,extracted_text,processing_status,source_metadata,extractor_version,processing_attempt,processing_claim_token)
    VALUES(doc,patient,body,'completed',meta,version,job.attempt_count,token)
    ON CONFLICT(document_id,patient_id) DO UPDATE SET extracted_text=EXCLUDED.extracted_text,processing_status=EXCLUDED.processing_status,
      source_metadata=EXCLUDED.source_metadata,extractor_version=EXCLUDED.extractor_version,
      processing_attempt=EXCLUDED.processing_attempt,processing_claim_token=EXCLUDED.processing_claim_token;
  UPDATE public.document_processing_jobs SET state='completed',finished_at=clock_timestamp(),lease_token=NULL,
    lease_expires_at=NULL,attempt_deadline_at=NULL,last_error_code=NULL
    WHERE document_id=doc AND patient_id=patient AND state='running' AND lease_token=token
      AND lease_expires_at>clock_timestamp() AND attempt_deadline_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Extraction claim expired'; END IF;
  UPDATE public.medical_documents SET processing_status='completed' WHERE id=doc AND patient_id=patient AND processing_status='processing';
  IF NOT FOUND OR job.lease_expires_at<=clock_timestamp() OR job.attempt_deadline_at<=clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Extraction completion could not be confirmed';
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.valid_extraction_payload(TEXT,JSONB,TEXT),public.fence_extraction_write(),
  public.fence_extraction_completion(),public.persist_document_extraction(UUID,UUID,UUID,TEXT,JSONB,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.valid_extraction_payload(TEXT,JSONB,TEXT),public.fence_extraction_write(),
  public.fence_extraction_completion(),public.persist_document_extraction(UUID,UUID,UUID,TEXT,JSONB,TEXT) TO health_wallet_app;
