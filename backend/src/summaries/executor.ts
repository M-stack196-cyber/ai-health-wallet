import {setTimeout as pause} from 'node:timers/promises';
import {canonicalSummaryJson} from './validation.js';
import {fakeSummaryRecipe,SummaryClientError,type createSummaryClient} from './client.js';
import {SummaryJobError,type createSummaryJobRepository,type SummaryClaim,type SummaryJob} from './jobs.js';

export interface SummaryExecutorConfig {enabled:boolean;patientId?:string;heartbeatMs:number;attemptMs:number;pollMs:number;drainMs:number;}
export const defaultSummaryExecutorConfig:Readonly<SummaryExecutorConfig>=Object.freeze({enabled:false,heartbeatMs:1000,attemptMs:5000,pollMs:1000,drainMs:1000});
export type ExecutorEvent='disabled'|'idle'|'completed'|'retry-scheduled'|'failed'|'lease-lost'|'safety-stop'|'stopped';
export class SummaryExecutorError extends Error {constructor(){super('Summary executor configuration refused.');this.name='SummaryExecutorError';}}
export type ExecutionResult='disabled'|'idle'|'busy'|'completed'|'failed'|'lease-lost'|'interrupted';
interface Dependencies {repository:ReturnType<typeof createSummaryJobRepository>;client:ReturnType<typeof createSummaryClient>;event?:(event:ExecutorEvent)=>void;}
function configValid(c:SummaryExecutorConfig){return typeof c.enabled==='boolean'&&[c.heartbeatMs,c.attemptMs,c.pollMs,c.drainMs].every(Number.isSafeInteger)&&c.heartbeatMs>=10&&c.heartbeatMs<=5000&&c.attemptMs>=20&&c.attemptMs<=60000&&c.pollMs>=10&&c.pollMs<=60000&&c.drainMs>=0&&c.drainMs<=5000&&(!c.enabled||typeof c.patientId==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(c.patientId));}
async function settled(work:Promise<unknown>|undefined,ms:number){if(!work)return true;let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work.then(()=>true,()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}finally{if(timer)clearTimeout(timer);}}

// Explicit construction only. Imported by neither API startup nor OCR runtime.
export function createSummaryExecutor(options:SummaryExecutorConfig,deps:Dependencies){
 const config=Object.freeze({...options});
 if(!configValid(config)||(config.enabled&&deps.repository.patientScope!==config.patientId))throw new SummaryExecutorError();
 let stopping=false,working:Promise<ExecutionResult>|undefined,loop:Promise<void>|undefined,controller:AbortController|undefined;
 const lifetime=new AbortController(),heartbeats=new Set<Promise<unknown>>();
 function event(e:ExecutorEvent){try{deps.event?.(e);}catch{/* Never forward observer exceptions. */}}
 function drained(){return !working&&heartbeats.size===0&&deps.client.activeRequests===0;}
 async function execute(signal?:AbortSignal):Promise<ExecutionResult>{
  let job:SummaryJob|undefined,c:SummaryClaim|undefined,token:AbortController|undefined;
  let clock:ReturnType<typeof setTimeout>|undefined,heart:ReturnType<typeof setInterval>|undefined;
  let leaseLost=false,timedOut=false;const cancelled=()=>token?.abort();
  try{
   if(signal?.aborted||stopping)return 'interrupted';
   await deps.repository.recover();if(signal?.aborted||stopping)return 'interrupted';
   job=await deps.repository.claim();if(!job){event('idle');return 'idle';}
   // Never touch an ambiguous or foreign returned identity, even through fake ports.
   if(job.patient_id!==config.patientId||!job.lease_token){stopping=true;event('safety-stop');return 'interrupted';}
   c={jobId:job.id,token:job.lease_token};token=new AbortController();controller=token;
   signal?.addEventListener('abort',cancelled,{once:true});if(signal?.aborted||stopping)token.abort();
   clock=setTimeout(()=>{timedOut=true;token!.abort();},config.attemptMs);
   heart=setInterval(()=>{
    if(token!.signal.aborted||heartbeats.size)return;
    const pending=(async()=>{try{if(!await deps.repository.heartbeat(c!)){leaseLost=true;token!.abort();}}catch{leaseLost=true;token!.abort();}})();
    heartbeats.add(pending);pending.finally(()=>heartbeats.delete(pending)).catch(()=>{});
   },config.heartbeatMs);
   if(token.signal.aborted)throw new SummaryClientError('CANCELLED');
   const {input,context,recipe}=await deps.repository.generationInput(c);
   if(canonicalSummaryJson(recipe)!==canonicalSummaryJson(fakeSummaryRecipe(context.input_sha256)))throw new SummaryClientError('INVALID_REQUEST');
   if(token.signal.aborted)throw new SummaryClientError('CANCELLED');
   const output=await deps.client.generate(input,context,token.signal);
   if(token.signal.aborted)throw new SummaryClientError('CANCELLED');
   if(!await deps.repository.publish(c,output,token.signal)){event('lease-lost');return 'lease-lost';}
   event('completed');return 'completed';
  }catch(error){
   if(!c){stopping=true;event('safety-stop');return 'interrupted';}
   if(leaseLost||error instanceof SummaryJobError&&['LEASE_LOST','SOURCE_INELIGIBLE'].includes(error.code)){event('lease-lost');return 'lease-lost';}
   const interrupted=!timedOut&&(stopping||signal?.aborted||token?.signal.aborted);
   const invalid=error instanceof SummaryClientError&&['INVALID_REQUEST','INVALID_RESPONSE','CLIENT_DISABLED','INVALID_CLIENT_CONFIG'].includes(error.code)||error instanceof SummaryJobError&&['INVALID_INPUT','INVALID_SUMMARY','CONFIG_CONFLICT'].includes(error.code);
   const retryable=!!interrupted||timedOut||error instanceof SummaryClientError&&error.retryable||error instanceof SummaryJobError&&error.code==='DATABASE_UNAVAILABLE';
   const code=interrupted?'CANCELLED':timedOut||error instanceof SummaryClientError&&error.code==='DEADLINE_EXCEEDED'?'MODEL_TIMEOUT':invalid?'INVALID_SUMMARY':'MODEL_FAILED';
   try{const saved=await deps.repository.fail(c,code,retryable);if(!saved){event('lease-lost');return 'lease-lost';}event(retryable&&job!.attempt_count<job!.max_attempts?'retry-scheduled':'failed');}
   catch{stopping=true;event('safety-stop');}
   return interrupted?'interrupted':'failed';
  }finally{
   if(clock)clearTimeout(clock);if(heart)clearInterval(heart);signal?.removeEventListener('abort',cancelled);token?.abort();if(controller===token)controller=undefined;
  }
 }
 const service={
  runOnce(signal?:AbortSignal):Promise<ExecutionResult>{
   if(!config.enabled){event('disabled');return Promise.resolve('disabled');}
   if(stopping)return Promise.resolve('interrupted');
   if(working||heartbeats.size||deps.client.activeRequests!==0)return Promise.resolve('busy');
   const active=execute(signal);working=active;
   active.finally(()=>{if(working===active)working=undefined;}).catch(()=>{});return active;
  },
  start(){
   if(!config.enabled){event('disabled');return;}
   if(loop||stopping)throw new SummaryExecutorError();
   loop=(async()=>{while(!stopping){await service.runOnce(lifetime.signal);if(stopping)break;try{await pause(config.pollMs,undefined,{signal:lifetime.signal});}catch{break;}}})();
   loop.catch(()=>{stopping=true;event('safety-stop');});
  },
  async stop(immediate=false){
   stopping=true;lifetime.abort();const start=performance.now();
   if(!immediate)await settled(working,Math.floor(config.drainMs/2));
   controller?.abort();
   await settled(working,Math.max(0,config.drainMs-(performance.now()-start)));
   while(!drained()&&performance.now()-start<config.drainMs)await pause(Math.min(10,Math.max(1,config.drainMs-(performance.now()-start))));
   const clean=drained();event(clean?'stopped':'safety-stop');return {drained:clean};
  },
  get stopped(){return stopping;},
 };
 return Object.freeze(service);
}
