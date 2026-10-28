import type pg from 'pg';
import {publicStatus} from './background-health.js';
import type {DocumentConfig} from '../config/documents.js';
import type {ProcessingConfig,RetrievalConfig} from './config.js';
import type {OriginalStorage} from '../documents/original-reader.js';
import type {DocumentProcessor} from './worker.js';
import type {composeBackground} from './background-runtime-core.js';
import {guard} from './background-config.js';
import {loadSystemFileCredentials,type SystemCredentialBundle} from '../stage-c/system-credentials.js';
import {pinnedCredentialFile,type CredentialFileSystem} from '../stage-c/credential-files.js';
import {preflight,type AwsRead} from '../integration/guards.js';
import {digest,operationalConfigIdentity,validateOperational,validateRuntimeGrant,verifyOperationalOwner,type OperationalSelection,type OperationalState,type ReadOnlySystemPorts} from './operational-authority.js';
import type {ProcessIdentity} from '../stage-c/system-supervision.js';

export class OperationalError extends Error {constructor(){super('Operational processing refused or stopped.');this.name='OperationalError';}}
export interface OperationalResources {pool:pg.Pool;processing:ProcessingConfig;retrieval:RetrievalConfig;documents:DocumentConfig;storage:OriginalStorage;processor:DocumentProcessor;closeStorage():void;}
export interface OperationalPorts {
 files:CredentialFileSystem;system:ReadOnlySystemPorts;self():ProcessIdentity;
 // Neither callback has a default: no ambient/home/profile/provider fallback.
 awsRead(credentials:SystemCredentialBundle,signal:AbortSignal):AwsRead;
 open(credentials:SystemCredentialBundle,signal:AbortSignal):Promise<OperationalResources>;
 network(signal:AbortSignal):Promise<{configurationSha256:string;workerInvocationId:string;enforced:true;expiresAt:number}>;
 wallNow():number;monotonicNow():number;
 compose:typeof composeBackground;
 health?:Parameters<typeof composeBackground>[1]['health'];
 credentialHeadroomMs?:number;
 log?:(event:OperationalState)=>void;
 signal?:AbortSignal;
}
const used=new Set<string>();
async function bounded<T>(ms:number,signal:AbortSignal,fn:(s:AbortSignal)=>Promise<T>):Promise<T>{
 const abort=new AbortController(),combined=AbortSignal.any([signal,abort.signal]);let timer:ReturnType<typeof setTimeout>|undefined;let onAbort:(()=>void)|undefined;
 try{return await Promise.race([Promise.resolve().then(()=>{combined.throwIfAborted();return fn(combined);}),new Promise<never>((_,reject)=>{onAbort=()=>reject(new OperationalError());combined.addEventListener('abort',onAbort,{once:true});timer=setTimeout(()=>{reject(new OperationalError());abort.abort();},ms);if(combined.aborted)onAbort();})]);}
 finally{if(timer)clearTimeout(timer);if(onAbort)combined.removeEventListener('abort',onAbort);abort.abort();}
}
// Each repository statement gets a transaction; authority loss before COMMIT
// rolls it back. COMMIT dispatch is the authorization linearization point. A loss
// concurrent with an already-dispatched COMMIT cannot retroactively undo it.
export function operationalDatabase(pool:Pick<pg.Pool,'connect'>,check:()=>Promise<void>,active:()=>void=()=>{}){
 return {async query<R extends pg.QueryResultRow>(sql:string,values:unknown[]){
  let c:pg.PoolClient|undefined;let discard=false;
  try{await check();c=await pool.connect();await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='3s'");await c.query("SET LOCAL lock_timeout='2s'");await check();
   // A post-statement authority check must not widen the original extraction
   // lease window. Retain the locked pre-completion DB timestamps (completion
   // clears them), and verify against DB time again immediately before COMMIT.
   let lease:{expires:string;deadline:string}|undefined;
   if(sql.startsWith('SELECT public.persist_document_extraction(')){
    lease=(await c.query<{expires:string;deadline:string}>(`SELECT lease_expires_at::text AS expires,attempt_deadline_at::text AS deadline
      FROM public.document_processing_jobs WHERE document_id=$1 AND patient_id=$2 AND lease_token=$3 AND state='running'
      AND lease_expires_at>clock_timestamp() AND attempt_deadline_at>clock_timestamp() FOR UPDATE`,values.slice(0,3))).rows[0];
    if(!lease)throw new OperationalError();
   }
   const result=await c.query<R>(sql,values);await check();active();
   if(lease){const row=(await c.query<{live:boolean}>('SELECT clock_timestamp()<$1::timestamptz AND clock_timestamp()<$2::timestamptz AS live',[lease.expires,lease.deadline])).rows[0];if(row?.live!==true)throw new OperationalError();}
   active();await c.query('COMMIT');return result;
  }catch{try{await c?.query('ROLLBACK');}catch{discard=true;}throw new OperationalError();}
  finally{c?.release(discard);}
 }};
}
export async function startOperational(input:OperationalSelection,ports:OperationalPorts){
 let s:OperationalSelection;try{s=structuredClone(input);validateOperational(s);guard(typeof ports.compose==='function');guard(Number.isSafeInteger(ports.credentialHeadroomMs??0)&&(ports.credentialHeadroomMs??0)>=0&&(ports.credentialHeadroomMs??0)<=6000);}catch{throw new OperationalError();}
 const p=s.credentials.binding.plan,key=p.bootId+':'+s.workerInvocationId;
 if(used.has(key)||used.size>=256)throw new OperationalError();used.add(key); // no stale same-process restart
 let state:OperationalState='starting',service:Awaited<ReturnType<typeof composeBackground>>|undefined,resources:OperationalResources|undefined,credentials:SystemCredentialBundle|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined,expiryTimer:ReturnType<typeof setTimeout>|undefined,closing:Promise<{cleanupVerified:boolean}>|undefined;
 const cancel=new AbortController();let terminal=false,lastWall=-Infinity,lastMono=-Infinity,deadline=Infinity,expiresWall=Infinity;
 let releasePromise:Promise<void>|undefined;let pendingReads=0,openingPending=false;
 const release=()=>releasePromise??=(async()=>{if(resources){try{resources.closeStorage();}finally{await resources.pool.end();}}})();
 let self:ProcessIdentity;try{self=structuredClone(ports.self());guard(s.credentials.directory.ownerUid===self.uid&&s.authorizationPin.ownerUid===self.uid&&Object.values(s.credentials.pins).every(pin=>pin.ownerUid===self.uid));}catch{throw new OperationalError();}
 const emit=(next:OperationalState)=>{state=next;try{ports.log?.(next);}catch{}};
 const lose=(reason:'expired'|'controller-lost'|'failed')=>{if(terminal)return;terminal=true;emit(reason);cancel.abort();void service?.stop(true).catch(()=>emit('failed'));};
 let auth:ReturnType<typeof pinnedCredentialFile>;try{auth=pinnedCredentialFile(s.credentials.directory,{...s.authorizationPin,name:'runtime-authorization.json',maxBytes:4096},ports.files);}catch{throw new OperationalError();}
 async function check(){
  if(terminal||cancel.signal.aborted)throw new OperationalError();
  try{await bounded(1000,cancel.signal,async signal=>{
   pendingReads++;try{
   const wall=ports.wallNow(),mono=ports.monotonicNow();guard(Number.isFinite(wall)&&Number.isFinite(mono)&&wall>=lastWall&&mono>=lastMono);lastWall=wall;lastMono=mono;if(wall>=expiresWall||mono>=deadline){lose('expired');throw new OperationalError();}
   let g;try{g=validateRuntimeGrant(await auth.read(),s,wall);}catch{if(wall>=lastWall&&mono>=deadline)lose('expired');throw new OperationalError();}
   guard(Date.parse(g.expiresAt)+(ports.credentialHeadroomMs??0)<=Date.parse(s.credentialsExpireAt));
   expiresWall=Date.parse(g.expiresAt);deadline=Math.min(deadline,mono+Date.parse(g.expiresAt)-wall);if(mono>=deadline){lose('expired');throw new OperationalError();}
   try{await verifyOperationalOwner(p,s.workerInvocationId,ports.system,self,signal);}catch{lose('controller-lost');throw new OperationalError();}
   const n=await ports.network(signal);guard(n.enforced===true&&n.configurationSha256===operationalConfigIdentity(s)&&n.workerInvocationId===s.workerInvocationId&&Number.isFinite(n.expiresAt)&&n.expiresAt>ports.wallNow()&&n.expiresAt-ports.wallNow()<=5000);
   await credentials?.assertUnchanged();
   if(terminal||cancel.signal.aborted||ports.monotonicNow()>=deadline||ports.wallNow()>=Date.parse(g.expiresAt)){lose('expired');throw new OperationalError();}
   }finally{pendingReads--;}
  });}catch{if(!terminal)lose('failed');throw new OperationalError();}
 }
 function clear(){if(timer)clearTimeout(timer);if(expiryTimer)clearTimeout(expiryTimer);ports.signal?.removeEventListener('abort',external);}
 async function stop(immediate=false){
  if(closing)return closing;
  if(!terminal)emit('draining');
  closing=(async()=>{let clean=false;
   try{if(service)await bounded(s.background.drainMs+6000,new AbortController().signal,()=>service!.stop(immediate));
    if(resources)await bounded(5000,new AbortController().signal,release);
    clean=pendingReads===0&&!openingPending;
   }catch{emit('failed');}finally{terminal=true;cancel.abort();clear();if(clean&&state==='draining')emit('stopped');}
   return {cleanupVerified:clean};})();return closing;
 }
 const external=()=>{void stop().catch(()=>emit('failed'));};ports.signal?.addEventListener('abort',external,{once:true});
 try{
  ports.signal?.throwIfAborted();await check();
  credentials=await loadSystemFileCredentials(s.credentials,ports.files);await check();
  const report=await bounded(10000,cancel.signal,signal=>preflight(ports.awsRead(credentials!,signal)));guard(report.passed&&report.checks.length===7);await check();
  // Start expiry/ownership monitoring before any resource opening; expired grants
  // cannot survive a slow factory. Late successful factory results are closed.
  expiryTimer=setTimeout(()=>lose('expired'),Math.max(1,deadline-ports.monotonicNow()));
  const tick=async()=>{try{await check();}catch{}if(!terminal)timer=setTimeout(()=>void tick(),250);};timer=setTimeout(()=>void tick(),250);
  openingPending=true;const opening=Promise.resolve().then(()=>ports.open(credentials!,cancel.signal)).finally(()=>{openingPending=false;});let accepted=false;
  try{resources=await bounded(5000,cancel.signal,()=>opening);accepted=true;}catch{cancel.abort();opening.then(async r=>{if(!accepted){try{r.closeStorage();await r.pool.end();}catch{}}},()=>{});throw new OperationalError();}await check();
  const policy=structuredClone({processing:resources.processing,retrieval:resources.retrieval,documents:resources.documents});
  guard(digest(policy)===s.resourcePolicySha256&&typeof resources.processor==='function');
  const c=policy.processing;
  for(const [n,min,max]of [[c.maxAttempts,1,5],[c.leaseMs,1000,300000],[c.attemptTimeoutMs,1000,900000],[c.heartbeatMs,100,60000],[c.retryBaseMs,1000,300000],[c.retryMaxMs,1000,3600000],[c.recoveryBatchSize,1,100]])guard(Number.isSafeInteger(n)&&n>=min&&n<=max);
  guard(c.heartbeatMs*2<c.leaseMs&&c.attemptTimeoutMs>=c.leaseMs&&c.retryMaxMs>=c.retryBaseMs);
  const r=policy.retrieval;
  for(const [n,min,max]of [[r.maxDownloadBytes,1024,20971520],[r.downloadTimeoutMs,1000,30000],[r.leaseCheckIntervalMs,100,5000],[r.maxConcurrentRetrievals,1,4]])guard(Number.isSafeInteger(n)&&n>=min&&n<=max);
  Object.freeze(policy.processing);Object.freeze(policy.retrieval);Object.freeze(policy.documents.storage);Object.freeze(policy.documents);
  const processDocument=resources.processor;
  guard(resources.documents.storage?.bucket===s.network.objectStorage.bucket&&resources.documents.storage.region===s.network.objectStorage.region&&resources.documents.storage.ownerAccountId===s.network.objectStorage.account&&resources.documents.storage.prefix===s.network.objectStorage.prefix&&resources.documents.storage.encryption==='AES256'&&!resources.documents.storage.kmsKeyId);
  guard(resources.storage.bucket===s.network.objectStorage.bucket&&resources.storage.prefix===s.network.objectStorage.prefix);
  guard(s.background.concurrency<=resources.retrieval.maxConcurrentRetrievals);
  const db=operationalDatabase(resources.pool,check,()=>guard(!terminal&&!cancel.signal.aborted&&ports.monotonicNow()<deadline&&ports.wallNow()<expiresWall)),original=resources.storage;
  const storage:OriginalStorage={bucket:original.bucket,prefix:original.prefix,async readOriginal(i){await check();let result;try{result=await original.readOriginal({...i,signal:AbortSignal.any([i.signal,cancel.signal])});}catch(error){if(error&&typeof error==='object'&&'name' in error&&['ExpiredToken','InvalidToken','InvalidAccessKeyId','SignatureDoesNotMatch'].includes(String(error.name)))lose('expired');throw new OperationalError();}await check();return result;}};
  const processor:DocumentProcessor=ctx=>processDocument({...ctx,signal:AbortSignal.any([ctx.signal,cancel.signal]),persistExtraction:async result=>{await check();await ctx.persistExtraction(result);}});
  service=await ports.compose(s.background,{...resources,...policy,storage,processor,profileUnchanged:check,systemAdmission:{verify:check,query:db.query},immediateShutdown:true,health:ports.health,closeResources:release,shutdown:cancel.signal,log:()=>{},fault:()=>lose('failed')});
  await check();emit('ready');
  if(ports.signal?.aborted)await stop();
  return Object.freeze({stop,verify:check,snapshot:()=>({service:'document-processing-operational',state,ready:state==='ready'&&!terminal&&service!.snapshot().ready,metrics:publicStatus(service!.snapshot()).metrics})});
 }catch{await stop(true);throw new OperationalError();}
}
