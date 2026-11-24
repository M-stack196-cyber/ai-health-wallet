import type {ReportedFactV1,EvidenceV1} from './contracts.js';
import type {SummarySnapshot} from './jobs.js';
import {SummaryJobError} from './jobs.js';
// Deliberately narrow, auditable catalogue. Unsupported prose/instructions are
// never promoted into facts. No diagnosis, medication or treatment inference.
export const catalogueVersion='english-lab-catalogue-v1';
export function sourceCatalogue(s:Readonly<SummarySnapshot>):ReportedFactV1[]{
 const facts:ReportedFactV1[]=[];let cursor=0;
 for(const raw of s.extracted_text.split('\n')){
  const trimOffset=raw.search(/\S/);
  const line=trimOffset>=0?raw.trim():'';
  const start=cursor+(trimOffset>=0?trimOffset:0);
  cursor+=raw.length+1;
  if(!line)continue;
  const match=/^(Glucose|Hemoglobin|Haemoglobin|Hgb|Hb)(?:\s*\([^)]+\))?\s*:?\s*(\d+(?:\.\d+)?|\?+)\s*(mg\/dL|mmol\/L|g\/dL|g\/L)?(?:\s+([\d.]+\s*-\s*[\d.]+))?$/di.exec(line);
  if(!match||!match.indices?.[1]||!match.indices?.[2])continue;
  const labelSpan=match.indices[1];
  const valueSpan=match.indices[2];
  const unitSpan=match.indices[3];
  const rangeSpan=match.indices[4];
  const ev=(text:string,relStart:number):EvidenceV1=>{
   const at=start+relStart;
   return {source_ref:s.id,start_byte:Buffer.byteLength(s.extracted_text.slice(0,at)),end_byte:Buffer.byteLength(s.extracted_text.slice(0,at+text.length)),quote:text,page:null};
  };
  const termIds:ReportedFactV1['term_ids']=[/^glucose$/i.test(match[1])?'glucose':'hemoglobin'];
  if(match[4]&&rangeSpan)termIds.push('reference_range');
  facts.push({
   id:'F'+(facts.length+1),
   kind:'measurement',
   evidence:ev(line,0),
   certainty:match[2].startsWith('?')?'ambiguous':'explicit',
   polarity:'affirmed',
   required:true,
   conflict_group:null,
   term_ids:termIds,
   measurement:{
    label:{text:match[1],evidence:ev(match[1],labelSpan[0])},
    value:match[2].startsWith('?')?null:{decimal:match[2],evidence:ev(match[2],valueSpan[0])},
    operator:null,
    unit:match[3]&&unitSpan?{text:match[3],evidence:ev(match[3],unitSpan[0])}:null,
    reported_range:match[4]&&rangeSpan?{text:match[4],evidence:ev(match[4],rangeSpan[0])}:null,
    reported_flag:null
   }
  });
 }
 if(!facts.length||facts.length>32)throw new SummaryJobError('SOURCE_INELIGIBLE');
 return facts;
}
