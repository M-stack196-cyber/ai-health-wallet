import {isAbsolute} from 'node:path';
import {guard} from '../processing/background-config.js';
import {target,parsePreparation,hash,type Preparation} from './safety.js';
export interface LiveOptions {phase:'seed'|'activate';run:string;evidenceDirectory:string;proofPath:string;proofSha256:string;preparation?:Preparation;}
const runtimeApprovals=new WeakSet<LiveOptions>();
export function assertRuntimeApproval(options:LiveOptions){guard(runtimeApprovals.has(options));}
export function parseLive(args:string[]):LiveOptions{
 guard(args[0]==='--seed'||args[0]==='--activate');const phase=args[0]==='--seed'?'seed':'activate';
 const requiredApproval=phase==='seed'?'--approve-synthetic-seeding':'--approve-service-activation';
 const required=['--profile','--account','--bucket','--region','--run-id','--evidence-dir','--supervision-receipt','--supervision-sha256'];
 if(phase==='activate')required.push('--patient','--control-patient','--cutoff','--approval-file','--approval-sha256');
 const values=new Map<string,string>(),approvals=new Set<string>();
 for(let i=1;i<args.length;i++){
  const key=args[i];if(key==='--approve-live-writes'||key===requiredApproval){guard(!approvals.has(key));approvals.add(key);continue;}
  guard(required.includes(key)&&!values.has(key));const value=args[++i];guard(!!value&&!value.startsWith('--'));values.set(key,value);
 }
 guard(approvals.size===2&&values.size===required.length);
 for(const key of ['profile','account','bucket','region'] as const)guard(values.get('--'+key)===target[key]);
 const run=values.get('--run-id')!,evidenceDirectory=values.get('--evidence-dir')!,proofPath=values.get('--supervision-receipt')!,proofSha256=values.get('--supervision-sha256')!;
 guard(/^stage-c-[a-f0-9]{24}$/.test(run)&&isAbsolute(evidenceDirectory)&&isAbsolute(proofPath)&&hash(proofSha256));
 const preparation=phase==='activate'?parsePreparation(['--check',...['profile','account','bucket','region','run-id','patient','control-patient','cutoff','approval-file','approval-sha256'].flatMap(k=>['--'+k,values.get('--'+k)!])]):undefined;
 const result=Object.freeze({phase,run,evidenceDirectory,proofPath,proofSha256,preparation});runtimeApprovals.add(result);return result;
}
