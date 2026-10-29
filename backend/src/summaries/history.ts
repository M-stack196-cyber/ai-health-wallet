import type {PatientDatabase} from '../patients/repository.js';
import {createSummaryJobRepository,SummaryJobError,type SummaryDatabase} from './jobs.js';
import {sourceCatalogue,catalogueVersion} from './catalogue.js';
import {fakeSummaryRecipe} from './client.js';
export interface HistoryScope {patientId:string;permittedDocumentIds?:readonly string[];}
export function createHistoryService(db:PatientDatabase&SummaryDatabase,resolve:()=>Promise<HistoryScope>){
 const check=async(scope:HistoryScope)=>{if(JSON.stringify(await resolve())!==JSON.stringify(scope))throw new SummaryJobError('SOURCE_INELIGIBLE');};
 return {
 async request(){
  const scope=await resolve(),repo=createSummaryJobRepository(db,scope.patientId);
  const candidates=(await db.query<{id:string;document_date:string|null;uploaded_at:Date}>(`SELECT d.id,d.document_date::text,d.uploaded_at FROM medical_documents d JOIN document_processing_jobs j ON (j.document_id,j.patient_id)=(d.id,d.patient_id) JOIN extracted_medical_text e ON (e.document_id,e.patient_id)=(d.id,d.patient_id) WHERE d.patient_id=$1 AND j.state='completed' AND e.processing_status='completed' AND ($2::uuid[] IS NULL OR d.id=ANY($2::uuid[])) ORDER BY COALESCE(d.document_date,(d.uploaded_at AT TIME ZONE 'UTC')::date),d.uploaded_at,d.id LIMIT 21`,[scope.patientId,scope.permittedDocumentIds===undefined?null:[...scope.permittedDocumentIds]])).rows;
  if(candidates.length>20)throw new SummaryJobError('INVALID_INPUT');
  const manifest=[];
  const {input_sha256:_,...pipeline}=fakeSummaryRecipe('0'.repeat(64));
  for(const d of candidates){
   try{const s=await repo.captureSnapshot(d.id),facts=sourceCatalogue(s),j=await repo.enqueue(s.id,facts,pipeline);
    manifest.push({document_id:d.id,job_id:j.id,event_date:d.document_date??d.uploaded_at.toISOString().slice(0,10),date_source:d.document_date?'document_date':'uploaded_at',catalogue_version:catalogueVersion});
   }catch(e){if(e instanceof SummaryJobError&&e.code==='SOURCE_INELIGIBLE')continue;throw e;}
  }
  if(!manifest.length)throw new SummaryJobError('SOURCE_INELIGIBLE');
  await check(scope);
  const body=JSON.stringify(manifest);
  const inserted=(await db.query(`INSERT INTO summary_history_requests(patient_id,manifest,manifest_sha256) VALUES($1,$2::jsonb,public.summary_digest($2::jsonb::text)) ON CONFLICT(patient_id,manifest_sha256) DO NOTHING RETURNING id`,[scope.patientId,body])).rows[0];
  const row=inserted??(await db.query('SELECT id FROM summary_history_requests WHERE patient_id=$1 AND manifest_sha256=public.summary_digest($2::jsonb::text)',[scope.patientId,body])).rows[0];
  await check(scope);return {id:row!.id,source_count:manifest.length,omitted_unsupported_records:candidates.length-manifest.length};
 },
 async get(id:string){
  const scope=await resolve();const row=(await db.query('SELECT * FROM summary_history_requests WHERE id=$1 AND patient_id=$2',[id,scope.patientId])).rows[0];
  if(!row)return undefined;
  if(scope.permittedDocumentIds&&row.manifest.some((m:any)=>!scope.permittedDocumentIds!.includes(m.document_id)))return undefined;
  const repo=createSummaryJobRepository(db,scope.patientId),entries=[];let status='completed';
  for(const m of row.manifest){
   const job=await repo.getJob(m.job_id);if(!job)return undefined;
   if(['failed','cancelled','superseded'].includes(job.state))status='failed';
   else if(job.state!=='completed'&&status!=='failed')status=job.state==='running'?'processing':status==='processing'?'processing':'queued';
   if(job.state==='completed'){
    const summary=(await repo.summaries(m.document_id)).find(a=>a.summary_job_id===m.job_id&&a.is_current);
    if(!summary)return undefined;
    entries.push({source_document_id:m.document_id,date:m.event_date,date_source:m.date_source,summary_id:summary.id,text:summary.summary_text,generated_at:summary.generated_at,reported_information:summary.structured_output.reported_findings,uncertainty:summary.structured_output.uncertainty,provenance:summary.provenance});
   }
  }
  await check(scope);
  // Recheck the whole manifest after all reads; partial histories never expose
  // a previously accessible source after a concurrent deletion/restriction.
  if(!(await db.query('SELECT id FROM summary_history_requests WHERE id=$1 AND patient_id=$2',[id,scope.patientId])).rows.length)return undefined;
  return {id,status,requested_at:row.created_at,assembled_at:new Date().toISOString(),policy_version:'history-source-sections-v1',source_count:row.manifest.length,language:'en',mode:'synthetic-offline',
   limitations:['Limited lab catalogue; unsupported text omitted.','Each report remains separate. Differences or contradictions are not reconciled.','Missing evidence remains missing; this is not a diagnosis or treatment recommendation.'],
   entries:status==='completed'?entries:[],history_text:status==='completed'?entries.map(e=>e.date+' ['+e.date_source+'] '+e.source_document_id+'\n'+e.text).join('\n\n'):null};
 }
 };
}
