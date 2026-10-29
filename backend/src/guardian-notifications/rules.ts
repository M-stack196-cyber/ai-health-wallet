import {notificationDigest} from './config.js';
export interface SeriousRule {id:string;version:string;field:string;units:string;operator:'gt'|'gte'|'lt'|'lte'|'between'|'outside';bounds:number[];context:Record<string,string>;approval:{status:'non_clinical_demo';notice:string};}
export const demoRule:SeriousRule={id:'NON_CLINICAL_DEMO_MARKER',version:'1',field:'DEMO_MARKER',units:'demo_units',operator:'gt',bounds:[10],context:{},approval:{status:'non_clinical_demo',notice:'Invented software-test marker only. No clinical analyte or real-patient threshold.'}};
export function validateDemoRule(r:SeriousRule){
 if(!r||Object.keys(r).sort().join(',')!=='approval,bounds,context,field,id,operator,units,version'||r.field!=='DEMO_MARKER'||r.units!=='demo_units'||r.approval?.status!=='non_clinical_demo'||!r.approval.notice||!/^[A-Z0-9_]{1,80}$/.test(r.id)||!/^\d{1,6}$/.test(r.version)||!['gt','gte','lt','lte','between','outside'].includes(r.operator)||!Array.isArray(r.bounds)||r.bounds.length!==(['between','outside'].includes(r.operator)?2:1)||r.bounds.some(n=>!Number.isFinite(n)||Math.abs(n)>1000000)||r.bounds.length===2&&r.bounds[0]>r.bounds[1]||!r.context||Object.entries(r.context).some(([k,v])=>!/^DEMO_[A-Z_]{1,40}$/.test(k)||typeof v!=='string'||!/^[a-zA-Z0-9_]{1,80}$/.test(v)))throw Error('Only explicit non-clinical demo rules are enabled.');
}
export const ruleDigest=(r:SeriousRule)=>notificationDigest(JSON.stringify(r));
export function evaluateDemoRule(r:SeriousRule,text:string,method:string){
 validateDemoRule(r);const indeterminate=(reason:string)=>({outcome:'INDETERMINATE' as const,reason,value:null,unit:null,explanation:'The synthetic rule could not be evaluated reliably. No serious trigger or reassuring conclusion is inferred.'});
 if(method!=='pdf_text')return indeterminate('unverified_ocr');
 const lines=text.split(/\r?\n/).map(s=>s.trim()),matches=lines.filter(s=>s.startsWith(r.field+':'));
 if(matches.length!==1)return indeterminate(matches.length?'ambiguous_value':'missing_value');
 const match=new RegExp('^'+r.field+':\\s*(-?\\d+(?:\\.\\d+)?)\\s+(\\S+)$').exec(matches[0]);if(!match)return indeterminate('ambiguous_or_missing_value');
 const value=Number(match[1]);if(!Number.isFinite(value)||Math.abs(value)>1000000)return indeterminate('unsupported_value');if(match[2]!==r.units)return indeterminate('unsupported_unit');
 for(const [key,v]of Object.entries(r.context)){const values=lines.filter(s=>s.startsWith(key+':'));if(values.length!==1||values[0]!==key+': '+v)return indeterminate('missing_or_unsupported_context');}
 const [a,b]=r.bounds;const trigger=r.operator==='gt'?value>a:r.operator==='gte'?value>=a:r.operator==='lt'?value<a:r.operator==='lte'?value<=a:r.operator==='between'?value>=a&&value<=b:value<a||value>b;
 return {outcome:trigger?'TRIGGERED' as const:'NOT_TRIGGERED' as const,reason:'explicit_demo_comparison',value,unit:r.units,explanation:trigger?'A predefined NON-CLINICAL synthetic software-test rule matched. This is not a diagnosis, treatment recommendation or an assertion of an emergency.':'The predefined synthetic comparison did not match. This is not a clinical assessment or reassurance.'};
}
