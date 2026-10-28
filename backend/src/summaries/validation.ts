import {createHash} from 'node:crypto';
import {SCHEMA,GLOSSARY} from './schema.generated.js';
import type {EvidenceV1,ReportedFactV1,SummaryInputV1,SummaryOutputV1,SummaryProvenanceV1,SummaryValidationContext,UncertaintyCode,EducationId} from './contracts.js';
export const summaryLimits=Object.freeze({sourceBytes:32768,inputBytes:262144,outputBytes:131072,renderBytes:32768,depth:20});
export type SummaryFailureCode='INVALID_INPUT'|'INVALID_OUTPUT'|'SOURCE_TOO_LARGE'|'INCOMPLETE_EXTRACTION'|'INVALID_EVIDENCE'|'UNSUPPORTED_CLAIM'|'SCOPE_MISMATCH'|'PROVENANCE_MISMATCH'|'VALIDATION_FAILED';
export class SummaryValidationError extends Error {constructor(readonly code:SummaryFailureCode){super('Medical summary validation refused: '+code);this.name='SummaryValidationError';}}
function ensure(ok:unknown,code:SummaryFailureCode='VALIDATION_FAILED'):asserts ok {if(!ok)throw new SummaryValidationError(code);}
function safe<T>(fn:()=>T,fallback:SummaryFailureCode='VALIDATION_FAILED'):T {try{return fn();}catch(e){throw new SummaryValidationError(e instanceof SummaryValidationError?e.code:fallback);}}
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const invalidUnicode=(s:string)=>/[\ud800-\udfff]/u.test(s)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(s);
export function canonicalSummaryJson(value:unknown):string {
  function walk(v:unknown,depth:number):string {
    ensure(depth<=summaryLimits.depth);
    if(v===null)return 'null';if(typeof v==='boolean')return String(v);
    if(typeof v==='number'){ensure(Number.isSafeInteger(v));return String(v);}
    if(typeof v==='string'){ensure(!invalidUnicode(v));return JSON.stringify(v);}
    if(Array.isArray(v))return '['+v.map(x=>walk(x,depth+1)).join(',')+']';
    ensure(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype);
    const o=v as Record<string,unknown>;ensure(Object.values(Object.getOwnPropertyDescriptors(o)).every(d=>'value'in d));
    return '{'+Object.keys(o).sort().map(k=>{ensure(!invalidUnicode(k));return JSON.stringify(k)+':'+walk(o[k],depth+1);}).join(',')+'}';
  }return safe(()=>walk(value,0));
}
export function summaryInputDigest(value:unknown):string{return safe(()=>digest(canonicalSummaryJson(value)));}
// Purpose-built evaluator for our fixed, generated schema vocabulary. Unknown
// keywords fail closed; this is not a general-purpose JSON Schema implementation.
type Rule={[$key:string]:unknown};
const definitions=SCHEMA.$defs as unknown as Record<string,Rule>;
const vocabulary=new Set(['$ref','type','properties','required','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','pattern','minimum','maximum','enum','const','anyOf']);
export function validateSummaryStructure(name:'SummaryInputV1'|'SummaryOutputV1'|'SummaryProvenanceV1',value:unknown):boolean {
  function check(r:Rule,v:unknown,depth:number):boolean {
    if(depth>summaryLimits.depth||Object.keys(r).some(k=>!vocabulary.has(k)))return false;
    if(r.$ref){const key=String(r.$ref).replace('#/$defs/','');return String(r.$ref)==='#/$defs/'+key&&!!definitions[key]&&check(definitions[key],v,depth+1);}
    if(r.anyOf)return (r.anyOf as Rule[]).some(x=>check(x,v,depth+1));
    if('const'in r&&v!==r.const)return false;if(r.enum&&!(r.enum as unknown[]).includes(v))return false;
    if(r.type==='null')return v===null;
    if(r.type==='boolean')return typeof v==='boolean';
    if(r.type==='integer')return typeof v==='number'&&Number.isSafeInteger(v)&&v>=Number(r.minimum)&&v<=Number(r.maximum);
    if(r.type==='string'){
      if(typeof v!=='string'||invalidUnicode(v)||[...v].length<Number(r.minLength)||[...v].length>Number(r.maxLength))return false;
      return !r.pattern||new RegExp(String(r.pattern),'u').test(v);
    }
    if(r.type==='array'){
      if(!Array.isArray(v)||v.length<Number(r.minItems)||v.length>Number(r.maxItems)||!v.every(x=>check(r.items as Rule,x,depth+1)))return false;
      return !r.uniqueItems||new Set(v.map(x=>canonicalSummaryJson(x))).size===v.length;
    }
    if(r.type==='object'){
      if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype)return false;
      const o=v as Record<string,unknown>,props=r.properties as Record<string,Rule>;
      return r.additionalProperties===false&&(r.required as string[]).every(k=>Object.hasOwn(o,k))&&Object.keys(o).every(k=>Object.hasOwn(props,k))
        &&Object.values(Object.getOwnPropertyDescriptors(o)).every(d=>'value'in d)&&Object.entries(props).every(([k,rule])=>check(rule,o[k],depth+1));
    }return r.enum!==undefined||r.const!==undefined;
  }return safe(()=>check(definitions[name],value,0));
}
// A small bounded JSON parser catches duplicate/escaped keys before JSON.parse
// could discard them. Only integer JSON number tokens are used in this contract.
export function parseSummaryJson(raw:Uint8Array,kind:'input'|'output'):unknown {
  const code:SummaryFailureCode=kind==='input'?'INVALID_INPUT':'INVALID_OUTPUT';
  function must(ok:unknown,failure:SummaryFailureCode=code):asserts ok {ensure(ok,failure);}
  return safe(()=>{
    must(raw.byteLength<=(kind==='input'?summaryLimits.inputBytes:summaryLimits.outputBytes),kind==='input'?'SOURCE_TOO_LARGE':'INVALID_OUTPUT');
    const s=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);let at=0,nodes=0;
    const skip=()=>{while(/[ \n\r\t]/.test(s[at]??'!'))at++;};
    const quoted=/"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
    const string=()=>{quoted.lastIndex=at;const m=quoted.exec(s);must(m,kind==='input'?'INVALID_INPUT':'INVALID_OUTPUT');at=quoted.lastIndex;return JSON.parse(m[0]) as string;};
    function value(depth:number):unknown {
      must(depth<=summaryLimits.depth&&++nodes<=10000,kind==='input'?'INVALID_INPUT':'INVALID_OUTPUT');skip();
      if(s[at]==='"')return string();
      if(s[at]==='{'){
        at++;skip();const o:Record<string,unknown>={};if(s[at]==='}'){at++;return o;}
        while(true){const k=string();must(!Object.hasOwn(o,k),kind==='input'?'INVALID_INPUT':'INVALID_OUTPUT');skip();must(s[at++]===':');
          Object.defineProperty(o,k,{value:value(depth+1),enumerable:true,writable:true,configurable:true});skip();if(s[at]==='}'){at++;return o;}must(s[at++]===',');skip();}
      }
      if(s[at]==='['){at++;skip();const a:unknown[]=[];if(s[at]===']'){at++;return a;}while(true){a.push(value(depth+1));skip();if(s[at]===']'){at++;return a;}must(s[at++]===',');skip();}}
      for(const [literal,v]of [['true',true],['false',false],['null',null]] as const)if(s.startsWith(literal,at)){at+=literal.length;return v;}
      const n=/^-?(?:0|[1-9][0-9]*)/.exec(s.slice(at));must(n,kind==='input'?'INVALID_INPUT':'INVALID_OUTPUT');at+=n[0].length;const x=Number(n[0]);must(Number.isSafeInteger(x));return x;
    }const result=value(0);skip();must(at===s.length,kind==='input'?'INVALID_INPUT':'INVALID_OUTPUT');try{canonicalSummaryJson(result);}catch{must(false);}
    return result;
  },code);
}
function evidence(e:EvidenceV1,input:SummaryInputV1,parent?:EvidenceV1){
  const b=Buffer.from(input.source.text,'utf8');
  ensure(e.quote.trim()&&e.source_ref===input.scope.source_ref&&e.page===null&&Number.isInteger(e.start_byte)&&Number.isInteger(e.end_byte)&&e.start_byte>=0&&e.end_byte>e.start_byte&&e.end_byte<=b.length,'INVALID_EVIDENCE');
  ensure(b.subarray(e.start_byte,e.end_byte).equals(Buffer.from(e.quote,'utf8')),'INVALID_EVIDENCE');
  if(parent)ensure(e.start_byte>=parent.start_byte&&e.end_byte<=parent.end_byte,'INVALID_EVIDENCE');
}
function validateFact(f:ReportedFactV1,input:SummaryInputV1){
  evidence(f.evidence,input);
  ensure(!/ignore (?:all|previous|prior)|system (?:prompt|message)|api[_ -]?key|reveal.*(?:record|patient)|execute.*(?:command|shell)/i.test(f.evidence.quote),'UNSUPPORTED_CLAIM');
  ensure((f.kind==='measurement')===(f.measurement!==null),'UNSUPPORTED_CLAIM');
  const m=f.measurement;
  if(m){
    for(const field of [m.label,m.value,m.operator,m.unit,m.reported_range,m.reported_flag])if(field)evidence(field.evidence,input,f.evidence);
    for(const field of [m.label,m.unit,m.reported_range])if(field)ensure(field.text.trim()&&field.text===field.evidence.quote,'UNSUPPORTED_CLAIM');
    if(m.value){ensure(m.value.decimal===m.value.evidence.quote&&f.certainty==='explicit','UNSUPPORTED_CLAIM');
      const a=Buffer.from(input.source.text).subarray(0,m.value.evidence.start_byte).toString(),b=Buffer.from(input.source.text).subarray(m.value.evidence.end_byte).toString();
      const boundary=(s:string)=>s!==''&&/[\p{L}\p{N}._,+\-−]/u.test(s);
      ensure(!boundary([...a].at(-1)??'')&&!boundary([...b][0]??''),'UNSUPPORTED_CLAIM');}
    if(m.operator)ensure(m.value!==null&&m.operator.symbol===m.operator.evidence.quote,'UNSUPPORTED_CLAIM');
    if(m.reported_flag){const map:Record<string,string>={h:'high',high:'high',l:'low',low:'low',n:'normal',normal:'normal'};ensure(map[m.reported_flag.evidence.quote.toLowerCase()]===m.reported_flag.value,'UNSUPPORTED_CLAIM');
      const bytes=Buffer.from(input.source.text),left=bytes.subarray(0,m.reported_flag.evidence.start_byte).toString(),right=bytes.subarray(m.reported_flag.evidence.end_byte).toString();
      const embedded=(c:string)=>/[\p{L}\p{N}_/.,+\-−]/u.test(c);ensure(!embedded([...left].at(-1)??'')&&!embedded([...right][0]??''),'UNSUPPORTED_CLAIM');}
  }
  for(const id of f.term_ids){
    if(id==='glucose')ensure(/\bglucose\b/i.test(f.evidence.quote),'UNSUPPORTED_CLAIM');
    if(id==='hemoglobin')ensure(/\b(?:ha?emoglobin|hgb|hb)\b/i.test(f.evidence.quote),'UNSUPPORTED_CLAIM');
    if(id==='reference_range')ensure(m?.reported_range!==null&&m!==null,'UNSUPPORTED_CLAIM');
    if(id==='ocr')ensure(input.source.method!=='pdf_text','UNSUPPORTED_CLAIM');
  }
}
export function validateSummaryInput(raw:unknown,context:SummaryValidationContext):SummaryInputV1 {
  return safe(()=>{
    if(raw&&typeof raw==='object'&&typeof (raw as SummaryInputV1).source?.text==='string')ensure(Buffer.byteLength((raw as SummaryInputV1).source.text)<=summaryLimits.sourceBytes,'SOURCE_TOO_LARGE');
    ensure(validateSummaryStructure('SummaryInputV1',raw),'INVALID_INPUT');const input=raw as SummaryInputV1;
    ensure(Buffer.byteLength(input.source.text)<=summaryLimits.sourceBytes&&Buffer.byteLength(canonicalSummaryJson(raw))<=summaryLimits.inputBytes,'SOURCE_TOO_LARGE');
    ensure(canonicalSummaryJson(input.scope)===canonicalSummaryJson({request_id:context.request_id,source_ref:context.source_ref,scope_token:context.scope_token}),'SCOPE_MISMATCH');
    ensure(input.source.extraction_status==='completed','INCOMPLETE_EXTRACTION');
    ensure(digest(input.source.text)===input.source.text_sha256&&summaryInputDigest(input)===context.input_sha256,'PROVENANCE_MISMATCH');
    ensure(input.source.text.trim()&&new Set(input.facts.map(f=>f.id)).size===input.facts.length,'INVALID_INPUT');
    const groups=new Map<string,number>();for(const f of input.facts){validateFact(f,input);if(f.conflict_group)groups.set(f.conflict_group,(groups.get(f.conflict_group)??0)+1);}
    ensure([...groups.values()].every(n=>n>=2),'INVALID_INPUT');return JSON.parse(canonicalSummaryJson(input));
  });
}
function expectedMetadata(input:SummaryInputV1,facts:ReportedFactV1[]){
  const codes=new Set<UncertaintyCode>(['page_locations_unavailable']),ids=new Set<string>(),terms=new Set<EducationId>();
  if(input.source.method!=='pdf_text'){codes.add('ocr_used');terms.add('ocr');}
  if(facts.length<input.facts.length)codes.add('limited_coverage');
  for(const f of facts){f.term_ids.forEach(x=>terms.add(x));
    if(f.certainty==='ambiguous'){codes.add('ambiguous_source');ids.add(f.id);}
    if(f.conflict_group){codes.add('conflicting_findings');ids.add(f.id);}
    if(f.measurement&&!f.measurement.value){codes.add('missing_measurement_value');ids.add(f.id);}
    if(f.measurement&&!f.measurement.unit){codes.add('missing_unit');ids.add(f.id);}
  }return {codes:[...codes].sort(),fact_ids:[...ids].sort(),terms:[...terms].sort()};
}
export function validateSummaryOutput(raw:unknown,source:unknown,context:SummaryValidationContext,recipe:SummaryProvenanceV1):SummaryOutputV1 {
  return safe(()=>{
    const input=validateSummaryInput(source,context);ensure(validateSummaryStructure('SummaryOutputV1',raw),'INVALID_OUTPUT');const out=raw as SummaryOutputV1;
    ensure(Buffer.byteLength(canonicalSummaryJson(out))<=summaryLimits.outputBytes,'INVALID_OUTPUT');
    ensure(canonicalSummaryJson(out.scope)===canonicalSummaryJson(input.scope),'SCOPE_MISMATCH');
    ensure(validateSummaryStructure('SummaryProvenanceV1',recipe)&&recipe.input_sha256===context.input_sha256&&canonicalSummaryJson(out.provenance)===canonicalSummaryJson(recipe),'PROVENANCE_MISMATCH');
    const facts=new Map(input.facts.map(f=>[f.id,f])),chosen=new Set(out.reported_findings.map(f=>f.id));
    ensure(chosen.size===out.reported_findings.length,'UNSUPPORTED_CLAIM');
    for(const f of out.reported_findings)ensure(facts.has(f.id)&&canonicalSummaryJson(f)===canonicalSummaryJson(facts.get(f.id)),'UNSUPPORTED_CLAIM');
    ensure(input.facts.every(f=>!f.required||chosen.has(f.id)),'UNSUPPORTED_CLAIM');
    for(const f of input.facts)if(f.conflict_group&&chosen.has(f.id))ensure(input.facts.filter(x=>x.conflict_group===f.conflict_group).every(x=>chosen.has(x.id)),'UNSUPPORTED_CLAIM');
    const meta=expectedMetadata(input,out.reported_findings);
    ensure(canonicalSummaryJson(out.uncertainty)===canonicalSummaryJson({codes:meta.codes,fact_ids:meta.fact_ids})&&canonicalSummaryJson(out.educational_explanations)===canonicalSummaryJson(meta.terms),'UNSUPPORTED_CLAIM');
    ensure(out.catalogue_coverage===(chosen.size===input.facts.length?'all_catalogued':'subset'),'UNSUPPORTED_CLAIM');return JSON.parse(canonicalSummaryJson(out));
  });
}
const warnings:Record<UncertaintyCode,string>={ambiguous_source:'Some extracted text is ambiguous; no uncertain number has been interpreted.',conflicting_findings:'The selected source statements conflict. The conflict has not been resolved.',limited_coverage:'This summary covers only part of the extracted report.',missing_measurement_value:'A measurement value is unavailable in this summary.',missing_unit:'A measurement unit is unavailable; no unit has been supplied.',ocr_used:'This report includes OCR text. Reading errors may remain.',page_locations_unavailable:'Verified page locations are unavailable.'};
export function renderSummary(raw:unknown,source:unknown,context:SummaryValidationContext,recipe:SummaryProvenanceV1):string {
  return safe(()=>{
    const output=validateSummaryOutput(raw,source,context,recipe);
    const lines=['Report summary','Source-reported information; not an independent diagnosis.'];
    for(const f of [...output.reported_findings].sort((a,b)=>a.evidence.start_byte-b.evidence.start_byte||(a.id<b.id?-1:a.id>b.id?1:0))){
      lines.push('Reported text: '+JSON.stringify(f.evidence.quote));
      const m=f.measurement;if(m){lines.push('Measurement: '+m.label.text+': '+(m.value?(m.operator?m.operator.symbol+' ':'')+m.value.decimal:'unavailable')+(m.unit?' '+m.unit.text:'; unit unavailable')+'.');
        if(m.reported_range)lines.push('Range printed in report: '+m.reported_range.text+'.');if(m.reported_flag)lines.push('Flag printed in report: '+m.reported_flag.evidence.quote+'.');}
    }
    if(output.educational_explanations.length)lines.push('General explanations (not interpretations of your results):');
    for(const id of output.educational_explanations)lines.push(GLOSSARY.entries[id].text);
    lines.push('Limitations:');for(const code of output.uncertainty.codes)lines.push(warnings[code]);
    const text=lines.join('\n');ensure(Buffer.byteLength(text)<=summaryLimits.renderBytes,'VALIDATION_FAILED');return text;
  });
}
