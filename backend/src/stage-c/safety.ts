import {backgroundConfig,guard,verifyApproval,type BackgroundConfig} from '../processing/background-config.js';
import {target,parseFlags,preflight,requireLive,type AwsRead} from '../integration/guards.js';
export {target};
export const uuid=(s:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
export const hash=(s:string)=>/^[a-f0-9]{64}$/.test(s);
export interface Preparation {readonly run:string;readonly controlPatientId:string;readonly config:BackgroundConfig;}
// Preparation CLI deliberately has no live mode, dotenv import, client or listener.
export function parsePreparation(args:string[]):Preparation {
 const flags=new Map<string,string>();const names=['--profile','--account','--bucket','--region','--run-id','--patient','--control-patient','--cutoff','--approval-file','--approval-sha256'];
 guard(args[0]==='--check');
 for(let i=1;i<args.length;i+=2){guard(names.includes(args[i])&&!flags.has(args[i])&&!!args[i+1]&&!args[i+1].startsWith('--'));flags.set(args[i],args[i+1]);}
 guard(flags.size===names.length);
 parseFlags(['--preflight',...['profile','account','bucket','region'].flatMap(k=>['--'+k,flags.get('--'+k)!])]);
 const run=flags.get('--run-id')!,controlPatientId=flags.get('--control-patient')!;
 guard(/^stage-c-[a-f0-9]{24}$/.test(run)&&uuid(controlPatientId)&&controlPatientId!==flags.get('--patient'));
 const config=backgroundConfig({PROCESSING_SERVICE_ENABLED:'true',PROCESSING_SERVICE_MODE:'canary',PROCESSING_CANARY_PATIENT_ID:flags.get('--patient'),
 PROCESSING_UPLOAD_CUTOFF:flags.get('--cutoff'),PROCESSING_APPROVAL_FILE:flags.get('--approval-file'),PROCESSING_APPROVAL_SHA256:flags.get('--approval-sha256')});
 guard(config.enabled);return Object.freeze({run,controlPatientId,config});
}
export async function checkPreparation(p:Preparation){
 guard(/^stage-c-[a-f0-9]{24}$/.test(p.run)&&uuid(p.controlPatientId)&&p.controlPatientId!==p.config.canary.patientId);
 guard(p.config.enabled&&p.config.concurrency===1&&p.config.pollMs===2000&&p.config.drainMs===30000);
 await verifyApproval(p.config);
}
// Always execute the existing seven checks afresh; no serialized report is accepted.
export async function freshPreflight(read:AwsRead){
 const report=await preflight(read);
 requireLive({...target,mode:'run',liveWrites:true},report);
 guard(report.checks.length===7);return report;
}
export interface UploadReceipt {
 run:string;role:'sentinel'|'mixed';patientId:string;documentId:string;key:string;
 fixtureSha256:string;originalSha256:string;bytes:number;versionId?:string;confirmed:boolean;
 observedAt:string;jobCount:number;state:'pending'|'running'|'completed';attempt:number;extractions:number;
 methods:readonly string[];pages:readonly number[];evidenceAttempt?:number;currentAttempt:boolean;
 originalUnchanged:boolean;privateObject:boolean;atomicCompletion:boolean;
}
export function checkReceipt(p:Preparation,r:UploadReceipt,role:UploadReceipt['role'],sha:string,now:number,completed=false){
 guard(r&&r.run===p.run&&r.role===role&&r.patientId===p.config.canary.patientId&&uuid(r.documentId));
 guard(/^medical-documents\/[0-9a-f-]{36}\.pdf$/.test(r.key)&&uuid(r.key.slice(target.prefix.length,-4)));
 guard(hash(sha)&&r.fixtureSha256===sha&&r.originalSha256===sha&&r.confirmed&&Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=1048576);
 const observed=Date.parse(r.observedAt);guard(Number.isFinite(observed)&&observed<=now&&now-observed<=30000);
 guard(r.jobCount===1&&r.originalUnchanged&&r.privateObject);
 if(role==='sentinel')guard(r.state==='pending'&&r.attempt===0&&r.extractions===0&&r.methods.length===0&&r.pages.length===0);
 else if(completed)guard(r.state==='completed'&&r.attempt===1&&r.extractions===1&&r.evidenceAttempt===1&&r.currentAttempt&&r.atomicCompletion
   &&r.methods.join(',')==='pdf_text,ocr'&&r.pages.join(',')==='1,2');
}
