import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {operationalFixture} from '../background-checks/operational-fixture.js';
import {digest,operationalConfigIdentity} from '../processing/operational-authority.js';
import {credentialSha256} from '../stage-c/credential-files.js';
import {startOperational} from '../processing/operational-runtime.js';
import {composeBackground} from '../processing/background-runtime-core.js';
import {coordinatorKey} from '../processing/background-coordinator.js';
const {assertIsolated}=await import(new URL('../../../infrastructure/stage-b/isolation.ts',import.meta.url).href);
await assertIsolated();
const {default:pg}=await import('pg');const {getDatabaseConfig}=await import('../config/env.js');
await assertIsolated(true);
const options=getDatabaseConfig(),inspector=new pg.Pool({...options,max:3,connectionTimeoutMillis:3000,statement_timeout:5000});
const extraction={text:'Synthetic offline OCR evidence.',method:'pdf_text',extractor:{name:'synthetic-operational',version:'v1'},source:{sha256:'a'.repeat(64),pageCount:1,pages:[{page:1,method:'pdf_text'}]}};
async function until(check:()=>Promise<boolean>){const end=Date.now()+8000;while(Date.now()<end){if(await check())return;await turn();}throw Error('Synthetic operational condition unavailable');}
async function fixture(){
 const f=operationalFixture(),owner=f.selection.background.canary.patientId,foreign=randomUUID();
 for(const patient of [owner,foreign])await inspector.query("INSERT INTO public.patients(id,email,password_hash,full_name) VALUES($1,$2,$3,'Synthetic operational')",[patient,patient+'@example.invalid','$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword']);
 const docs:string[]=[];for(const [patient,when]of [[owner,'2026-10-23T01:00:00.000Z'],[owner,'2026-10-22T00:00:00.000Z'],[foreign,'2026-10-23T01:00:00.000Z']]){const id=randomUUID();docs.push(id);await inspector.query("INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,uploaded_at) VALUES($1,$2,$3,$4,'synthetic.pdf','pdf','lab_report',$5)",[id,patient,f.resources.storage.bucket,'medical-documents/'+id+'.pdf',when]);}
 const path=f.selection.credentials.directory.path+'/postgres-password.json';const envelope=JSON.parse(Buffer.from(f.data.get(path)!).toString());envelope.password=options.password;const bytes=Buffer.from(JSON.stringify(envelope));f.data.set(path,bytes);f.metadata.get(path)!.size=bytes.length;f.selection.credentials.pins.postgres.sha256=credentialSha256(bytes);
 f.selection.resourcePolicySha256=digest({processing:f.resources.processing,retrieval:f.resources.retrieval,documents:f.resources.documents});f.grant.configurationSha256=operationalConfigIdentity(f.selection);f.pinGrant();
 f.ports.compose=composeBackground;
 f.ports.open=async credentials=>{const db=await credentials.databaseOptions();assert.equal(db.password===options.password,true);f.resources.pool=new pg.Pool({...db,max:5,connectionTimeoutMillis:3000,statement_timeout:3000});return f.resources;};
 const job=async(id=docs[0])=>(await inspector.query('SELECT state,attempt_count FROM public.document_processing_jobs WHERE document_id=$1',[id])).rows[0];
 const untouched=async()=>{for(const id of docs.slice(1)){const j=await job(id);assert.equal(j.state,'pending');assert.equal(j.attempt_count,0);}};
 const count=async()=>Number((await inspector.query('SELECT count(*)::int AS n FROM public.extracted_medical_text WHERE document_id=$1 AND patient_id=$2',[docs[0],owner])).rows[0].n);
 return {f,docs,owner,job,untouched,count};
}
test('B03.4 isolated operational worker composition',{timeout:120000},async t=>{
 try{
 await t.test('actual scheduler persists once within patient and cutoff scope',async()=>{
  const x=await fixture();let calls=0;x.f.resources.processor=async c=>{calls++;await c.persistExtraction(extraction as any);};
  const s=await startOperational(x.f.selection,x.f.ports);try{await until(async()=>(await x.job()).state==='completed');assert.equal(await x.count(),1);assert.equal(calls,1);await x.untouched();}finally{assert.equal((await s.stop()).cleanupVerified,true);}
 });
 await t.test('controller loss after SQL persistence statement rolls back extraction and completion',async()=>{
  const x=await fixture();let intercepted=false;const open=x.f.ports.open;
  x.f.ports.open=async(...args)=>{const r=await open(...args),connect=r.pool.connect.bind(r.pool);(r.pool as any).connect=async()=>{const c=await connect();return new Proxy(c,{get(target,key){if(key==='query')return async(sql:string,values?:unknown[])=>{const out=await c.query(sql,values);if(sql.includes('public.persist_document_extraction(')){intercepted=true;x.f.units.controller=null;}return out;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});};return r;};
  x.f.resources.processor=async c=>{await c.persistExtraction(extraction as any);};const s=await startOperational(x.f.selection,x.f.ports);
  try{await until(async()=>intercepted);await assert.rejects(s.verify());assert.equal((await s.stop(true)).cleanupVerified,true);assert.equal(await x.count(),0);assert.notEqual((await x.job()).state,'completed');await x.untouched();}finally{await s.stop(true);}
 });
 await t.test('runtime expiry aborts active worker and prevents later extraction',async()=>{
  const x=await fixture();let entered=false,cancelled=false;
  x.f.resources.processor=c=>new Promise((_resolve,reject)=>{entered=true;const abort=()=>{cancelled=true;reject(Error('Synthetic cancellation'));};c.signal.addEventListener('abort',abort,{once:true});if(c.signal.aborted)abort();});
  const s=await startOperational(x.f.selection,x.f.ports);try{await until(async()=>entered);x.f.advance(60001);await assert.rejects(s.verify());assert.equal(s.snapshot().state,'expired');assert.equal((await s.stop(true)).cleanupVerified,true);assert.equal(cancelled,true);assert.equal(await x.count(),0);assert.notEqual((await x.job()).state,'completed');await x.untouched();}finally{await s.stop(true);}
 });
 await t.test('post-statement authority observation cannot commit after original database lease expiry',async()=>{
  const x=await fixture();Object.assign(x.f.resources.processing,{leaseMs:1000,heartbeatMs:100,attemptTimeoutMs:3000});
  x.f.selection.resourcePolicySha256=digest({processing:x.f.resources.processing,retrieval:x.f.resources.retrieval,documents:x.f.resources.documents});x.f.grant.configurationSha256=operationalConfigIdentity(x.f.selection);x.f.pinGrant();
  let expires:string|undefined,hold=false,expired=false;const open=x.f.ports.open,network=x.f.ports.network;
  x.f.ports.open=async(...args)=>{const r=await open(...args),connect=r.pool.connect.bind(r.pool);(r.pool as any).connect=async()=>{const c=await connect();return new Proxy(c,{get(target,key){if(key==='query')return async(sql:string,values?:unknown[])=>{const out=await c.query(sql,values);if(sql.includes('AS expires'))expires=out.rows[0]?.expires;if(sql.startsWith('SELECT public.persist_document_extraction('))hold=true;return out;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});};return r;};
  x.f.ports.network=async signal=>{if(hold){await until(async()=>{expired=(await inspector.query('SELECT clock_timestamp()>=$1::timestamptz AS expired',[expires])).rows[0].expired;return expired;});}return network(signal);};
  x.f.resources.processor=async c=>{await c.persistExtraction(extraction as any);};const s=await startOperational(x.f.selection,x.f.ports);
  try{await until(async()=>expired);await until(async()=>s.snapshot().ready===false);await s.stop(true);assert.equal(await x.count(),0);assert.notEqual((await x.job()).state,'completed');await x.untouched();}finally{await s.stop(true);}
 });
 await t.test('dedicated PostgreSQL coordinator excludes a second operational invocation',async()=>{
  const x=await fixture(),y=await fixture();let entered=false;x.f.resources.processor=c=>new Promise((_resolve,reject)=>{entered=true;c.signal.addEventListener('abort',()=>reject(Error('Synthetic cancellation')),{once:true});});
  const s=await startOperational(x.f.selection,x.f.ports);try{await until(async()=>entered);await assert.rejects(startOperational(y.f.selection,y.f.ports));assert.equal((await y.job()).state,'pending');assert.equal((await y.job()).attempt_count,0);await x.untouched();await y.untouched();}finally{assert.equal((await s.stop(true)).cleanupVerified,true);}
  const c=await inspector.connect();try{assert.equal((await c.query('SELECT pg_try_advisory_lock($1,$2) AS owned',[...coordinatorKey])).rows[0].owned,true);await c.query('SELECT pg_advisory_unlock($1,$2)',[...coordinatorKey]);}finally{c.release(true);}
 });
 }finally{await inspector.end();}
});
