import type {ReportedFactV1,EvidenceV1} from './contracts.js';
import type {SummarySnapshot} from './jobs.js';
import {SummaryJobError} from './jobs.js';

export const catalogueVersion='english-lab-catalogue-v2';

export type LabTopic = 'glucose' | 'hemoglobin' | 'hematocrit' | 'wbc' | 'rbc' | 'platelets' | 'creatinine' | 'sodium' | 'potassium' | 'chloride' | 'lab_measurement';

export function classifyLabTopic(label: string): LabTopic {
  const s = label.toLowerCase();
  if (/\bglucose\b/.test(s)) return 'glucose';
  if (/\b(?:ha?emoglobin|hgb|hb)\b/.test(s)) return 'hemoglobin';
  if (/\b(?:hematocrit|haematocrit|hct)\b/.test(s)) return 'hematocrit';
  if (/\b(?:wbc|white\s+blood\s+cells?|leukocytes?)\b/.test(s)) return 'wbc';
  if (/\b(?:rbc|red\s+blood\s+cells?|erythrocytes?)\b/.test(s)) return 'rbc';
  if (/\b(?:platelets?|plt)\b/.test(s)) return 'platelets';
  if (/\b(?:creatinine|creat)\b/.test(s)) return 'creatinine';
  if (/\b(?:sodium|na)\b/.test(s)) return 'sodium';
  if (/\b(?:potassium|k)\b/.test(s)) return 'potassium';
  if (/\b(?:chloride|cl)\b/.test(s)) return 'chloride';
  return 'lab_measurement';
}

const SKIP_LABEL = /^(?:medical\s+laboratory|laboratory\s+report|test\s+results?|parameter|patient\s+id|date|name|age|gender|sex|doctor|hospital|specimen|sample|page|phone|address)\b/i;
const ROW_RE = /^([A-Za-z][A-Za-z0-9()\/.,\s-]{1,56}?)\s*:?\s+(\d+(?:\.\d+)?|\?+)\s*(x10\^?\d+\/[a-zA-Zµu]+|10\^?\d+\/[a-zA-Zµu]+|mg\/dL|mmol\/L|g\/dL|g\/L|mEq\/L|IU\/L|U\/L|ng\/mL|pg\/mL|ug\/dL|µg\/dL|fL|pg|%|\/uL|\/µL)?(?:\s+([<>≤≥]?\s*\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?))?$/di;

export function sourceCatalogue(s:Readonly<SummarySnapshot>):ReportedFactV1[]{
 const facts:ReportedFactV1[]=[];let cursor=0;
 for(const raw of s.extracted_text.split('\n')){
  const trimOffset=raw.search(/\S/);
  const line=trimOffset>=0?raw.trim():'';
  const start=cursor+(trimOffset>=0?trimOffset:0);
  cursor+=raw.length+1;
  if(!line)continue;
  const match=ROW_RE.exec(line);
  if(!match||!match.indices?.[1]||!match.indices?.[2])continue;
  const rawLabel=match[1].trim();
  if(SKIP_LABEL.test(rawLabel))continue;
  const labelSpan=match.indices[1];
  const valueSpan=match.indices[2];
  const unitSpan=match.indices[3];
  const rangeSpan=match.indices[4];
  const ev=(text:string,relStart:number):EvidenceV1=>{
   const at=start+relStart;
   return {source_ref:s.id,start_byte:Buffer.byteLength(s.extracted_text.slice(0,at)),end_byte:Buffer.byteLength(s.extracted_text.slice(0,at+text.length)),quote:text,page:null};
  };
  const primaryTopic=classifyLabTopic(rawLabel);
  const termIds:ReportedFactV1['term_ids']=[primaryTopic];
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
    label:{text:rawLabel,evidence:ev(rawLabel,labelSpan[0])},
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
