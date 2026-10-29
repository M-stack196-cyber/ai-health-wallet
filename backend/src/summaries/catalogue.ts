import type {ReportedFactV1,EvidenceV1} from './contracts.js';
import type {SummarySnapshot} from './jobs.js';
import {SummaryJobError} from './jobs.js';
// Deliberately narrow, auditable catalogue. Unsupported prose/instructions are
// never promoted into facts. No diagnosis, medication or treatment inference.
export const catalogueVersion='english-lab-catalogue-v1';
export function sourceCatalogue(s:Readonly<SummarySnapshot>):ReportedFactV1[]{
 const facts:ReportedFactV1[]=[];let cursor=0;
 for(const raw of s.extracted_text.split('\n')){
  const line=raw.trim(),start=cursor+raw.indexOf(line);cursor+=raw.length+1;
  const match=/^(Glucose|Hemoglobin|Haemoglobin|Hgb|Hb)\s*:?\s*(\d+(?:\.\d+)?|\?+)\s*(mg\/dL|mmol\/L|g\/dL|g\/L)?$/i.exec(line);
  if(!match)continue;
  const ev=(text:string,at:number):EvidenceV1=>({source_ref:s.id,start_byte:Buffer.byteLength(s.extracted_text.slice(0,at)),end_byte:Buffer.byteLength(s.extracted_text.slice(0,at+text.length)),quote:text,page:null});
  const valueAt=start+line.indexOf(match[2],match[1].length),unitAt=match[3]?start+line.lastIndexOf(match[3]):0;
  facts.push({id:'F'+(facts.length+1),kind:'measurement',evidence:ev(line,start),certainty:match[2].startsWith('?')?'ambiguous':'explicit',polarity:'affirmed',required:true,conflict_group:null,
   term_ids:[/^glucose$/i.test(match[1])?'glucose':'hemoglobin'],measurement:{label:{text:match[1],evidence:ev(match[1],start)},value:match[2].startsWith('?')?null:{decimal:match[2],evidence:ev(match[2],valueAt)},operator:null,unit:match[3]?{text:match[3],evidence:ev(match[3],unitAt)}:null,reported_range:null,reported_flag:null}});
 }
 if(!facts.length||facts.length>32)throw new SummaryJobError('SOURCE_INELIGIBLE');
 return facts;
}
