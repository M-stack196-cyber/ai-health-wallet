import {createHash,randomUUID} from 'node:crypto';
import {sourceCatalogue} from '../summaries/catalogue.js';
import {canonicalSummaryJson} from '../summaries/validation.js';
import type {SummarySnapshot} from '../summaries/jobs.js';
import {createRagRepository,type RagDatabase,type Chunk,type DoctorRagScope} from './repository.js';
import {createRagClient,chunkerVersion,validateVector,insufficient,ragUnavailable,safetyNotice,safetyNoticeId} from './client.js';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
// Identical fail-closed policy to the Python workflow; no document text is used
// to choose authorization, tools or instructions.
export function recordTopic(q:string){if(/\b(diagnos\w*|prescrib\w*|treatment|medication|symptom\w*|system|prompt|secret|ignore|exfiltrat\w*)\b/i.test(q))return null;if(/\bglucose\b/i.test(q))return 'glucose';if(/\b(hemoglobin|haemoglobin|hgb|hb)\b/i.test(q))return 'hemoglobin';return null;}
// Mirrors rag_service.workflow.SYMPTOM; the Python reply must agree or the answer is refused.
export const symptomRelated=(q:string)=>/\b(symptom\w*|pain\w*|aches?|aching|fever\w*|cough\w*|nausea\w*|vomit\w*|dizz\w*|headache\w*|rash\w*|swell\w*|bleed\w*|breath\w*|fatigue\w*|hurt\w*)\b/i.test(q);
export function createRagService(db:RagDatabase,patient:string,client:ReturnType<typeof createRagClient>,authorize:()=>Promise<void>,doctor?:DoctorRagScope){
 const repo=createRagRepository(db,patient,doctor);
 return {
 async index(id:string,signal?:AbortSignal){
  await authorize();const s=await repo.snapshot(id),pages=await repo.pages(s);
  const output=await client.call('chunks',{text:s.extracted_text,pages},signal);
  if(output.chunker!==chunkerVersion||output.source_sha256!==digest(s.extracted_text)||!Array.isArray(output.chunks)||output.chunks.length<1||output.chunks.length>128)throw ragUnavailable();
  const source=Buffer.from(s.extracted_text);
  let pageStart=0;const bounds=pages?.map((p:any)=>{const bound={page:p.page,start:pageStart,end:pageStart+Buffer.byteLength(p.text)};pageStart=bound.end+2;return bound;});
  const chunks:Chunk[]=output.chunks.map((c:any,i:number)=>{
   if(c.order!==i||!Number.isSafeInteger(c.start_byte)||!Number.isSafeInteger(c.end_byte)||c.start_byte<0||c.end_byte<=c.start_byte||c.end_byte>source.length||typeof c.text!=='string'||source.subarray(c.start_byte,c.end_byte).toString()!==c.text||!(c.page===null||Number.isSafeInteger(c.page)&&c.page>0&&c.page<=s.source_metadata.source.pageCount))throw ragUnavailable();
   if(bounds?!bounds.some((p:any)=>p.page===c.page&&c.start_byte>=p.start&&c.end_byte<=p.end):c.page!==null)throw ragUnavailable();
   validateVector(c.embedding);return c;
  });
  await authorize();signal?.throwIfAborted();return {document_id:id,indexed_chunks:await repo.index(s,chunks,chunkerVersion),chunker:chunkerVersion,embedding_model:'synthetic-hash-32-v1',mode:'synthetic-offline'};
 },
 async query(question:string,category?:string,signal?:AbortSignal){
  await authorize();const embedded=await client.call('embedding',{question},signal),rows=await repo.retrieve(validateVector(embedded.embedding),category);
  // Refuse oversized evidence sets rather than silently suppress contradictions.
  const records:Record<string,any>[]=[],sources:Record<string,any>[]=[];const seen=new Set<string>();const topic=recordTopic(question);
  if(rows.length<=20)for(const row of rows){
   let facts;try{facts=sourceCatalogue({...row,id:row.snapshot_id} as SummarySnapshot);}catch{continue;}
   const approved=[];
   for(const f of facts){if(f.term_ids[0]!==topic||f.evidence.start_byte<row.start_byte||f.evidence.end_byte>row.end_byte)continue;
    const identity=row.document_id+':'+f.id;if(seen.has(identity))continue;seen.add(identity);
    const citation_id='C'+(sources.length+1),m=f.measurement!;
    approved.push({citation_id,topic,label:m.label.text,value:m.value?.decimal??null,unit:m.unit?.text??null,quote:f.evidence.quote,uncertain:f.certainty==='ambiguous'});
    sources.push({...row,citation_id,quote:f.evidence.quote,start_byte:f.evidence.start_byte,end_byte:f.evidence.end_byte});
   }
   if(approved.length)records.push({text:row.chunk_text,document_id:row.document_id,facts:approved});
  }
  if(sources.length>32){sources.length=0;records.length=0;}
  await authorize();const context=canonicalSummaryJson(records),context_sha256=digest(context);
  const answer=await client.call('answers',{question,context_json:context,context_sha256,...(doctor?{allowed_document_ids:[...doctor.permittedDocumentIds]}:{})},signal);
  if(answer.context_sha256!==context_sha256||answer.provenance?.provider!=='synthetic-offline'||answer.provenance?.model!=='exact-evidence-selector'||answer.provenance?.revision!=='1'||answer.provenance?.policy!=='patient-records-rag-v1')throw ragUnavailable();
  const symptom=symptomRelated(question);if((answer.safety_notice??null)!==(symptom?safetyNoticeId:null))throw ragUnavailable();
  const expected=sources.map(s=>s.citation_id),answered=answer.status==='answered';
  // Shape first: a reply without a proper citation list is refused explicitly, never by accident.
  if(typeof answer.status!=='string'||answered&&!(Array.isArray(answer.selected)&&answer.selected.every((x:unknown)=>typeof x==='string')))throw ragUnavailable();
  if(answered&&(!expected.length||canonicalSummaryJson(answer.selected)!==canonicalSummaryJson(expected)))throw ragUnavailable();
  if(!answered&&!['no_records','insufficient'].includes(answer.status))throw ragUnavailable();
  const facts=records.flatMap(r=>r.facts);
  const citations=answered?sources.map(s=>({id:s.citation_id,document_id:s.document_id,document_name:s.original_filename,document_date:s.document_date,upload_date:s.uploaded_at,page:s.page,chunk_reference:s.id,source_reference:s.extraction_id,start_byte:s.start_byte,end_byte:s.end_byte,quote:s.quote})):[];
  const text=answered?'The records report:\n'+facts.map(f=>'Source-reported '+f.label+': '+(f.value??'unavailable')+(f.unit?' '+f.unit:'; unit unavailable')+'. ['+f.citation_id+']').join('\n')+'\nDifferent source values are preserved separately and have not been reconciled. This is not a diagnosis or treatment recommendation.':insufficient;
  const shown=symptom?text+'\n\n'+safetyNotice:text;
  const result={status:answered?'answered':'insufficient',answer:shown,...(symptom?{safety_notice:safetyNoticeId}:{}),citations,language:'en',mode:'synthetic-offline',uncertainty:{limited_catalogue:true,ambiguous:facts.some(f=>f.uncertain),missing_values:facts.some(f=>f.value===null)},provenance:{...answer.provenance,embedding_model:'synthetic-hash-32-v1',chunker:chunkerVersion}};
  await authorize();signal?.throwIfAborted();const id=randomUUID();await repo.save(id,question,result,answered?sources:[]);await authorize();
  const saved=await repo.get(id);if(!saved)throw ragUnavailable();return {id,...saved.structured_answer};
 },
 async get(id:string){await authorize();const result=await repo.get(id);await authorize();return result?{id,...result.structured_answer}:undefined;}
 };
}
