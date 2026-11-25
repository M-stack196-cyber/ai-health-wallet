import {createHash,randomUUID} from 'node:crypto';
import {sourceCatalogue} from '../summaries/catalogue.js';
import {canonicalSummaryJson} from '../summaries/validation.js';
import type {SummarySnapshot} from '../summaries/jobs.js';
import {createRagRepository,type RagDatabase,type Chunk,type DoctorRagScope} from './repository.js';
import {createRagClient,chunkerVersion,validateVector,insufficient,ragUnavailable,safetyNotice,safetyNoticeId} from './client.js';
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');

const STOP_WORDS=new Set(['what','which','where','when','who','whom','whose','why','how','the','and','for','are','was','were','is','am','be','been','being','have','has','had','do','does','did','will','would','shall','should','can','could','may','might','must','show','tell','give','list','find','get','fetch','read','check','see','view','my','me','mine','our','ours','your','yours','his','her','hers','their','theirs','this','that','these','those','from','with','about','into','onto','upon','over','under','between','level','levels','value','values','result','results','test','tests','report','reports','record','records','normal','range','ranges','please','kindly','or','of','in','on','at','to','by','as','an','a','all','every','full','complete','entire','medical','health','lab','labs','parameter','parameters','detail','details','information','info','summary','summarize','explain']);

const ABBREV_MAP:Record<string,string>={
  hb:'hemoglobin',hgb:'hemoglobin',haemoglobin:'hemoglobin',
  hct:'hematocrit',haematocrit:'hematocrit',pcv:'hematocrit',
  wbc:'wbc',tlc:'wbc',leukocytes:'wbc',leucocytes:'wbc',
  rbc:'rbc',erythrocytes:'rbc',
  plt:'platelets',platelet:'platelets',platelets:'platelets',
  creat:'creatinine',creatinine:'creatinine',
  na:'sodium',sodium:'sodium',
  k:'potassium',potassium:'potassium',
  cl:'chloride',chloride:'chloride',
  fbs:'glucose',rbs:'glucose',glucose:'glucose',sugar:'glucose'
};

function fuzzyContains(haystack:string,needle:string):boolean{
  if(!needle)return false;
  if(haystack.includes(needle))return true;
  if(needle.length<5)return false;
  const words=haystack.split(/[^a-z0-9]+/).filter(w=>w.length>=4);
  for(const w of words){
    if(Math.abs(w.length-needle.length)>2)continue;
    if(w.slice(0,4)===needle.slice(0,4)){
      let diffs=0,i=0,j=0;
      while(i<w.length&&j<needle.length){
        if(w[i]===needle[j]){i++;j++;}
        else{diffs++;if(diffs>2)break;if(w.length>needle.length)i++;else if(needle.length>w.length)j++;else{i++;j++;}}
      }
      diffs+=(w.length-i)+(needle.length-j);
      if(diffs<=2)return true;
    }
  }
  return false;
}

export function extractQueryKeywords(q:string):string[]{
  const raw=q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out:string[]=[];
  for(const w of raw){
    if(ABBREV_MAP[w]){out.push(ABBREV_MAP[w]);continue;}
    if(w.length>=2&&!STOP_WORDS.has(w))out.push(w);
  }
  return [...new Set(out)];
}

// Identical fail-closed policy to the Python workflow; no document text is used
// to choose authorization, tools or instructions.
export function recordTopic(q:string){
  if(/\b(diagnos\w*|prescrib\w*|treatment|medication|symptom\w*|system|prompt|secret|ignore|exfiltrat\w*)\b/i.test(q))return null;
  if(/\b(all|every|full|complete|entire)\b.*\b(results?|tests?|values?|reports?|records?|labs?|parameters?)\b|\b(what|show|list|give|summarize|explain)\b.*\b(my\s+(?:lab\s+|medical\s+|health\s+)?(?:results?|tests?|reports?|records?|values?|summary))\b/i.test(q))return 'all_measurements';
  if(/\b(glucose|sugar|fbs|rbs)\b/i.test(q))return 'glucose';
  if(/\b(hemoglobin|haemoglobin|hgb|hb)\b/i.test(q))return 'hemoglobin';
  if(/\b(hematocrit|haematocrit|hct|pcv)\b/i.test(q))return 'hematocrit';
  if(/\b(wbc|tlc|white\s+blood\s+cells?|leukocytes?|leucocytes?)\b/i.test(q))return 'wbc';
  if(/\b(rbc|red\s+blood\s+cells?|erythrocytes?)\b/i.test(q))return 'rbc';
  if(/\b(platelets?|plt)\b/i.test(q))return 'platelets';
  if(/\b(creatinine|creat)\b/i.test(q))return 'creatinine';
  if(/\b(sodium|na)\b/i.test(q))return 'sodium';
  if(/\b(potassium|k)\b/i.test(q))return 'potassium';
  if(/\b(chloride|cl)\b/i.test(q))return 'chloride';
  if(/\belectrolytes?\b/i.test(q))return 'electrolytes';
  if(/\b(cbc|fbc|complete\s+blood\s+count|blood\s+count)\b/i.test(q))return 'cbc';
  return 'keyword_match';
}
function matchesTopic(topic:string, f:any, q:string, docContext=''):boolean{
  const tid = f.term_ids[0];
  if(topic==='all_measurements')return true;
  if(topic==='electrolytes')return ['sodium','potassium','chloride'].includes(tid);
  if(topic==='cbc')return ['hemoglobin','hematocrit','wbc','rbc','platelets'].includes(tid);
  if(topic==='keyword_match'){
    const label = (f.measurement?.label?.text ?? '').toLowerCase();
    const keywords = extractQueryKeywords(q);
    if(!keywords.length)return true;
    if(keywords.some(w=>label.includes(w)||tid.includes(w)||fuzzyContains(label,w)))return true;
    if(docContext&&keywords.some(w=>fuzzyContains(docContext,w)))return true;
    return false;
  }
  return tid===topic;
}
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
  await authorize();
  for(const docId of await repo.unindexedDocumentIds(category)){try{await this.index(docId,signal);}catch{}}
  const embedded=await client.call('embedding',{question},signal),rows=await repo.retrieve(validateVector(embedded.embedding),category);
  const records:Record<string,any>[]=[],sources:Record<string,any>[]=[];const seen=new Set<string>();const topic=recordTopic(question);
  const keywords=extractQueryKeywords(question);
  if(rows.length<=20)for(const row of rows){
   if(sources.length>=28)break;
   const docContext=((row.original_filename??'')+'\n'+(row.extracted_text??row.chunk_text??'')).toLowerCase();
   let facts:any[]=[];try{facts=sourceCatalogue({...row,id:row.snapshot_id} as SummarySnapshot);}catch{}
   const approved:any[]=[];
   for(const f of facts){
    if(sources.length>=28)break;
    if(!topic||!matchesTopic(topic,f,question,docContext)||f.evidence.start_byte<row.start_byte||f.evidence.end_byte>row.end_byte)continue;
    const identity=row.document_id+':'+f.id;if(seen.has(identity))continue;seen.add(identity);
    const citation_id='C'+(sources.length+1),m=f.measurement!;
    approved.push({citation_id,topic:f.term_ids[0],label:m.label.text,value:m.value?.decimal??null,unit:m.unit?.text??null,reported_range:m.reported_range?.text??null,quote:f.evidence.quote,uncertain:f.certainty==='ambiguous',document_name:row.original_filename??null});
    sources.push({...row,citation_id,quote:f.evidence.quote,start_byte:f.evidence.start_byte,end_byte:f.evidence.end_byte});
   }
   if(topic&&!approved.length){
    const lines=(row.chunk_text??'').split('\n');
    let lineOffset=0;
    for(const rawLine of lines){
     if(sources.length>=28)break;
     const line=rawLine.trim();
     const relStart=rawLine.search(/\S/);
     const byteStart=row.start_byte+Buffer.byteLength((row.chunk_text??'').slice(0,lineOffset+(relStart>=0?relStart:0)));
     lineOffset+=rawLine.length+1;
     if(!line)continue;
     const lowerLine=line.toLowerCase();
     const lineMatches=!keywords.length||keywords.some(w=>fuzzyContains(lowerLine,w)||fuzzyContains((row.original_filename??'').toLowerCase(),w));
     if(lineMatches){
      const identity=row.document_id+':line:'+byteStart;if(seen.has(identity))continue;seen.add(identity);
      const citation_id='C'+(sources.length+1);
      const byteEnd=byteStart+Buffer.byteLength(line);
      approved.push({citation_id,topic:'document_text',label:'Record Line',value:line,unit:null,reported_range:null,quote:line,uncertain:false,document_name:row.original_filename??null});
      sources.push({...row,citation_id,quote:line,start_byte:byteStart,end_byte:byteEnd});
     }
    }
   }
   if(approved.length)records.push({text:row.chunk_text,document_id:row.document_id,document_name:row.original_filename??null,facts:approved});
  }
  await authorize();const context=canonicalSummaryJson(records),context_sha256=digest(context);
  const answer=await client.call('answers',{question,context_json:context,context_sha256,...(doctor?{allowed_document_ids:[...doctor.permittedDocumentIds]}:{})},signal);
  if(answer.context_sha256!==context_sha256||answer.provenance?.provider!=='synthetic-offline'||answer.provenance?.model!=='exact-evidence-selector'||answer.provenance?.revision!=='1'||answer.provenance?.policy!=='patient-records-rag-v1')throw ragUnavailable();
  const symptom=symptomRelated(question);if((answer.safety_notice??null)!==(symptom?safetyNoticeId:null))throw ragUnavailable();
  const expected=sources.map(s=>s.citation_id),expectedSet=new Set(expected),answered=answer.status==='answered';
  if(typeof answer.status!=='string'||answered&&!(Array.isArray(answer.selected)&&answer.selected.every((x:unknown)=>typeof x==='string')))throw ragUnavailable();
  const selectedSet=new Set<string>(answered?answer.selected:[]);
  if(answered&&(!answer.selected.length||selectedSet.size!==answer.selected.length||answer.selected.some((id:string)=>!expectedSet.has(id))))throw ragUnavailable();
  if(!answered&&!['no_records','insufficient'].includes(answer.status))throw ragUnavailable();
  const activeSources=answered?sources.filter(s=>selectedSet.has(s.citation_id)):[];
  const facts=answered?records.flatMap(r=>r.facts).filter((f:any)=>selectedSet.has(f.citation_id)):[];
  const citations=answered?activeSources.map(s=>({id:s.citation_id,document_id:s.document_id,document_name:s.original_filename,document_date:s.document_date,upload_date:s.uploaded_at,page:s.page,chunk_reference:s.id,source_reference:s.extraction_id,start_byte:s.start_byte,end_byte:s.end_byte,quote:s.quote})):[];
  const text=answered?'The records report:\n'+facts.map(f=>f.topic==='document_text'?'• '+f.value+(f.document_name?' (Source: '+f.document_name+')':'')+' ['+f.citation_id+']':'• '+f.label+': '+(f.value??'unavailable')+(f.unit?' '+f.unit:'; unit unavailable')+(f.reported_range?' (Reference range: '+f.reported_range+')':'')+(f.document_name?' — '+f.document_name:'')+' ['+f.citation_id+']').join('\n')+'\nDifferent source values are preserved separately and have not been reconciled. This is not a diagnosis or treatment recommendation.':insufficient;
  const shown=symptom?text+'\n\n'+safetyNotice:text;
  const result={status:answered?'answered':'insufficient',answer:shown,...(symptom?{safety_notice:safetyNoticeId}:{}),citations,language:'en',mode:'synthetic-offline',uncertainty:{limited_catalogue:true,ambiguous:facts.some(f=>f.uncertain),missing_values:facts.some(f=>f.value===null)},provenance:{...answer.provenance,embedding_model:'synthetic-hash-32-v1',chunker:chunkerVersion}};
  await authorize();signal?.throwIfAborted();const id=randomUUID();await repo.save(id,question,result,activeSources);await authorize();
  const saved=await repo.get(id);if(!saved)throw ragUnavailable();return {id,...saved.structured_answer};
 },
 async get(id:string){await authorize();const result=await repo.get(id);await authorize();return result?{id,...result.structured_answer}:undefined;}
 };
}
