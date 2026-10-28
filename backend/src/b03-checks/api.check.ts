import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {once} from 'node:events';
import express from 'express';
import type {QueryResultRow} from 'pg';
import type {AuthenticationConfig} from '../config/auth.js';
import type {PatientDatabase} from '../patients/repository.js';
import {createProcessingRoutes,publicProcessing,type ProcessingApiOptions} from '../processing/api.js';
import {createTokenService} from '../auth/tokens.js';
import {errorHandler} from '../http/errors.js';
import {createProcessingWorker} from '../processing/worker.js';
import type {createProcessingService} from '../processing/service.js';
const auth:AuthenticationConfig={jwtKey:randomBytes(32),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,jwtIssuer:'b03-synthetic',jwtAudience:'b03-patient',argonMemoryKiB:65536,argonTimeCost:3,argonParallelism:1,maxHashConcurrency:2,rateLimitWindowMs:900000,rateLimitMax:100};
const cutoff='2026-10-23T00:00:00.000Z';
async function fixture(enabled=true,options:ProcessingApiOptions={}){
 const patient=randomUUID(),id=randomUUID(),other=randomUUID(),dir=await mkdtemp('/tmp/health-wallet-b03-api-');await chmod(dir,0o700);
 const bytes=Buffer.from(JSON.stringify({version:1,mode:'canary',patientId:patient,uploadCutoff:cutoff,profile:'ai-health-wallet',account:'402909940531',bucket:'ai-health-wallet-records-402909940531',region:'ap-southeast-2'}));
 const path=dir+'/approval.json';await writeFile(path,bytes,{mode:0o600});
 const state={document_id:id,state:'failed',attempt_count:1,max_attempts:3,last_error_code:'INTERRUPTED',verified:false,eligible:true};
 let mutations=0,queries=0,fail=false;
 const database:PatientDatabase={async query<R extends QueryResultRow>(sql:string,values:unknown[]){queries++;
  if(fail)throw Error('SYNTHETIC_PRIVATE_DRIVER_FAILURE');
  if(sql.startsWith('WITH candidate')){
   assert.match(sql,/j.patient_id=\$2/);assert.match(sql,/d.patient_id=\$3::uuid/);assert.match(sql,/d.uploaded_at >= \$4::timestamptz/);assert.match(sql,/FOR UPDATE OF j,d/);
   if(values[0]===id&&values[1]===patient&&values[2]===patient&&values[3]===cutoff&&state.eligible&&state.state==='failed'&&state.attempt_count>0&&state.attempt_count<state.max_attempts&&state.last_error_code!=='INVALID_INPUT'){
    mutations++;state.state='retry_wait';return {rows:[{id}] as unknown as R[]};
   }return {rows:[]};
  }
  assert.match(sql,/j.document_id=\$1 AND j.patient_id=\$2/);
  return {rows:(values[0]===id&&values[1]===patient?[{...state,eligible:enabled&&state.eligible}]:[]) as unknown as R[]};
 }};
 const app=express();app.use(express.json());app.use('/api/v1',createProcessingRoutes(database,auth,{...(enabled?{retryApproval:{approvalPath:path,approvalSha256:createHash('sha256').update(bytes).digest('hex'),canary:{patientId:patient,uploadCutoff:cutoff}}}:{}),...options}));app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');
 const own=await createTokenService(auth).issue(patient),foreign=await createTokenService(auth).issue(other);
 const request=async(method='GET',token=own,target:string=id,body:unknown={})=>{
  const response=await fetch('http://127.0.0.1:'+a.port+'/api/v1/documents/'+target+(method==='GET'?'/processing':'/processing-retries'),{method,headers:{Authorization:'Bearer '+token,...(method==='POST'?{'Content-Type':'application/json'}:{})},body:method==='POST'?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
  const value=await response.json();assert.equal(response.headers.get('cache-control'),'no-store');
  const text=JSON.stringify(value);assert.ok(!text.includes('SYNTHETIC_PRIVATE')&&!text.includes('lease_token')&&!text.includes('patient_id')&&!text.includes('extracted_text'));
  return {status:response.status,value};
 };
 return {state,path,request,own,foreign,get mutations(){return mutations;},get queries(){return queries;},fault(){fail=true;},async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true});}};
}
test('B03 status and retry require authentication before SQL',async()=>{const f=await fixture();try{for(const method of ['GET','POST'])assert.equal((await f.request(method,'invalid')).status,401);assert.equal(f.queries,0);}finally{await f.close();}});
test('B03 unknown foreign and malformed references have identical denial',async()=>{const f=await fixture();try{for(const method of ['GET','POST']){const r=[await f.request(method,f.foreign),await f.request(method,f.own,randomUUID()),await f.request(method,f.own,'bad')];assert.ok(r.every(x=>x.status===404));assert.equal(new Set(r.map(x=>JSON.stringify(x.value))).size,1);}assert.equal(f.mutations,0);}finally{await f.close();}});
test('B03 default retry is disabled while truthful status remains readable',async()=>{const f=await fixture(false);try{const r=await f.request();assert.equal(r.status,200);assert.equal(r.value.processing.retry_allowed,false);assert.equal((await f.request('POST')).status,503);assert.equal(f.mutations,0);}finally{await f.close();}});
test('B03 approved bounded retry is idempotent without resetting attempts',async()=>{const f=await fixture();try{assert.equal((await f.request()).value.processing.retry_allowed,true);const responses=await Promise.all([f.request('POST'),f.request('POST'),f.request('POST')]);assert.ok(responses.every(r=>r.status===202));assert.equal(f.mutations,1);assert.equal(f.state.attempt_count,1);}finally{await f.close();}});
for(const state of ['pending','running','retry_wait'])test('B03 '+state+' retry requests do not create jobs or reset leases',async()=>{const f=await fixture();try{f.state.state=state;assert.equal((await f.request('POST')).status,202);assert.equal(f.mutations,0);}finally{await f.close();}});
test('B03 verified completion is idempotent and legacy completion is not claimed',async()=>{const f=await fixture();try{f.state.state='completed';f.state.verified=true;assert.equal((await f.request('POST')).status,200);f.state.verified=false;assert.equal((await f.request()).value.processing.status,'unavailable');assert.equal((await f.request('POST')).status,409);assert.equal(f.mutations,0);}finally{await f.close();}});
for(const reason of ['historical','exhausted','invalid','legacy'])test('B03 '+reason+' jobs cannot be manually readmitted',async()=>{const f=await fixture();try{if(reason==='historical')f.state.eligible=false;if(reason==='exhausted')f.state.attempt_count=3;if(reason==='invalid')f.state.last_error_code='INVALID_INPUT';if(reason==='legacy')f.state.attempt_count=0;assert.equal((await f.request('POST')).status,409);assert.equal(f.mutations,0);}finally{await f.close();}});
for(const mode of ['checksum','permissions','missing'])test('B03 '+mode+' approval failure prevents retry admission',async()=>{const f=await fixture();try{if(mode==='checksum')await writeFile(f.path,'{}');if(mode==='permissions')await chmod(f.path,0o644);if(mode==='missing')await rm(f.path);assert.equal((await f.request()).value.processing.retry_allowed,false);assert.equal((await f.request('POST')).status,503);assert.equal(f.mutations,0);}finally{await f.close();}});
test('B03 client cannot supply a scope prompt text reset or retry policy',async()=>{const f=await fixture();try{for(const body of [null,[],{patient_id:randomUUID()},{reset:true},{max_attempts:10},{text:'synthetic'}])assert.equal((await f.request('POST',f.own,undefined,body)).status,400);assert.equal(f.mutations,0);}finally{await f.close();}});
test('B03 retry rate limits and database errors disclose no private detail',async()=>{const f=await fixture(true,{retryLimit:1});try{assert.equal((await f.request('POST')).status,202);assert.equal((await f.request('POST')).status,429);f.fault();assert.equal((await f.request()).status,500);}finally{await f.close();}});
test('B03 public projection never implies whole pipeline completion',()=>{const p=publicProcessing({document_id:randomUUID(),state:'completed',attempt_count:2,max_attempts:3,last_error_code:null,verified:true,eligible:true},true);assert.equal(p.stage,'extraction');assert.equal(p.status,'completed');assert.ok(!JSON.stringify(p).includes('summary'));});
test('B03 cancellation during recovery does not claim another job',async()=>{
 const controller=new AbortController();let claims=0;
 const service={async recover(){controller.abort();return 0;},async claim(){claims++;}} as unknown as ReturnType<typeof createProcessingService>;
 const worker=createProcessingWorker(service,{maxAttempts:3,leaseMs:60000,attemptTimeoutMs:300000,heartbeatMs:15000,retryBaseMs:30000,retryMaxMs:300000,recoveryBatchSize:50},async()=>{throw Error('must not process');});
 assert.equal(await worker.runOnce(controller.signal),'idle');assert.equal(claims,0);
});
