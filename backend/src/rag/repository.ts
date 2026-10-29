import type {PatientDatabase} from '../patients/repository.js';
import type {SummaryDatabase,SummaryConnection,SummarySnapshot} from '../summaries/jobs.js';
import {createSummaryJobRepository} from '../summaries/jobs.js';
import {embeddingModel,ragUnavailable} from './client.js';
export type RagDatabase=PatientDatabase&SummaryDatabase;
export interface Chunk {order:number;start_byte:number;end_byte:number;text:string;page:number|null;embedding:number[];}
export interface DoctorRagScope {grantId:string;sessionHash:string;permittedDocumentIds:readonly string[];}
export function createRagRepository(db:RagDatabase,patient:string,doctor?:DoctorRagScope){
 const snapshots=createSummaryJobRepository(db,patient);
 async function tx<T>(work:(c:SummaryConnection)=>Promise<T>){
  const c=await db.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='10s'");await c.query("SELECT set_config('app.rag_patient_id',$1,true)",[patient]);await c.query("SELECT set_config('app.doctor_session_hash',$1,true)",[doctor?.sessionHash??'']);const out=await work(c);await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 }
 return {
 snapshot:(id:string)=>snapshots.captureSnapshot(id),
 async pages(s:SummarySnapshot){
  const r=(await db.query('SELECT structured_content FROM document_processing_results WHERE document_id=$1 AND patient_id=$2 AND attempt=$3 AND lease_token=$4',[s.document_id,patient,s.processing_attempt,s.processing_claim_token])).rows[0];
  const pages=r?.structured_content?.pages?.map((p:any)=>({page:p.page,text:p.text}));
  return pages&&pages.map((p:any)=>p.text).join('\n\n')===s.extracted_text?pages:null;
 },
 async index(s:SummarySnapshot,chunks:Chunk[],version:string){
  return tx(async c=>{
   await c.query('SELECT public.rag_clear_embeddings($1,$2,$3)',[s.document_id,patient,s.id]);
   for(const chunk of chunks){
    const row=(await c.query(`INSERT INTO medical_document_chunks(document_id,patient_id,chunk_order,chunk_text,source_reference,snapshot_id,source_fingerprint,chunker_version,start_byte,end_byte,page)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(document_id,patient_id,chunk_order) DO UPDATE SET chunk_text=EXCLUDED.chunk_text,source_reference=EXCLUDED.source_reference,snapshot_id=EXCLUDED.snapshot_id,source_fingerprint=EXCLUDED.source_fingerprint,chunker_version=EXCLUDED.chunker_version,start_byte=EXCLUDED.start_byte,end_byte=EXCLUDED.end_byte,page=EXCLUDED.page RETURNING id`,[s.document_id,patient,chunk.order,chunk.text,{extraction_id:s.extraction_id,extractor_version:s.extractor_version,processing_attempt:s.processing_attempt,source_sha256:s.source_metadata.source.sha256},s.id,s.source_fingerprint,version,chunk.start_byte,chunk.end_byte,chunk.page])).rows[0];
    await c.query('INSERT INTO rag_chunk_embeddings(chunk_id,document_id,patient_id,snapshot_id,source_fingerprint,model_key,dimensions,embedding) VALUES($1,$2,$3,$4,$5,$6,32,$7::vector)',[row!.id,s.document_id,patient,s.id,s.source_fingerprint,embeddingModel,JSON.stringify(chunk.embedding)]);
   }
   return chunks.length;
  });
 },
 async retrieve(vector:number[],category?:string){
  return tx(async c=>(await c.query(`WITH authorized AS MATERIALIZED (
   SELECT c.*,s.extraction_id,s.extracted_text,s.source_metadata,s.extractor_version,s.processing_attempt,s.processing_claim_token,
   d.original_filename,d.document_date::text,d.uploaded_at,e.embedding FROM rag_chunk_embeddings e
   JOIN medical_document_chunks c ON (c.id,c.document_id,c.patient_id)=(e.chunk_id,e.document_id,e.patient_id)
   JOIN summary_source_snapshots s ON (s.id,s.document_id,s.patient_id)=(c.snapshot_id,c.document_id,c.patient_id)
   JOIN medical_documents d ON (d.id,d.patient_id)=(c.document_id,c.patient_id)
   WHERE e.patient_id=$1 AND c.patient_id=$1 AND e.model_key=$2 AND e.dimensions=32 AND public.summary_source_current(s)
   AND ($3::text IS NULL OR d.category=$3) AND ($5::uuid[] IS NULL OR d.id=ANY($5::uuid[])))
   SELECT *,embedding <=> $4::vector AS distance FROM authorized ORDER BY embedding <=> $4::vector,document_id,chunk_order LIMIT 21`,[patient,embeddingModel,category??null,JSON.stringify(vector),doctor?[...doctor.permittedDocumentIds]:null])).rows);
 },
 async save(id:string,question:string,result:Record<string,any>,sources:Record<string,any>[]){
  return tx(async c=>{
   await c.query('SELECT id FROM patients WHERE id=$1 FOR SHARE',[patient]);
   const unique=[...new Map(sources.map(s=>[s.snapshot_id,s])).values()].sort((a,b)=>a.document_id.localeCompare(b.document_id));
   for(const s of unique){const good=await c.query('SELECT 1 FROM summary_source_snapshots s WHERE s.id=$1 AND s.patient_id=$2 AND public.lock_summary_source(s)',[s.snapshot_id,patient]);if(!good.rows.length)throw ragUnavailable();}
   await c.query(`INSERT INTO rag_interactions(id,patient_id,question,answer,rag_contract_version,result_status,structured_answer,provenance,sharing_grant_id) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8)`,[id,patient,question,result.answer,result.status,result,result.provenance,doctor?.grantId??null]);
   for(const s of sources)await c.query('INSERT INTO rag_answer_evidence(interaction_id,patient_id,document_id,chunk_id,snapshot_id,source_fingerprint,citation_id,quote) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,patient,s.document_id,s.id,s.snapshot_id,s.source_fingerprint,s.citation_id,s.quote]);
   for(const s of unique)await c.query('INSERT INTO rag_interaction_sources(interaction_id,document_id,patient_id,sharing_grant_id) VALUES($1,$2,$3,$4)',[id,s.document_id,patient,doctor?.grantId??null]);
  });
 },
 async get(id:string){return tx(async c=>(await c.query('SELECT id,structured_answer,created_at FROM rag_interactions WHERE id=$1 AND patient_id=$2 AND rag_contract_version=1 AND sharing_grant_id IS NOT DISTINCT FROM $3::uuid',[id,patient,doctor?.grantId??null])).rows[0]);}
 };
}
