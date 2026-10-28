import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile,readdir,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import express from 'express';
import type {QueryResultRow} from 'pg';
import type {PatientDatabase} from '../patients/repository.js';
import type {AuthenticationConfig} from '../config/auth.js';
import type {DocumentConfig} from '../config/documents.js';
import type {DocumentStorage} from '../documents/storage.js';
import {createPatientRoutes} from '../auth/routes.js';
import {createDocumentRoutes} from '../documents/routes.js';
import {createTokenService} from '../auth/tokens.js';
import {errorHandler} from '../http/errors.js';

const auth:AuthenticationConfig={jwtKey:randomBytes(32),jwtAlgorithm:'HS256',jwtLifetimeSeconds:900,
 jwtIssuer:'b02-synthetic',jwtAudience:'b02-patient',argonMemoryKiB:65536,argonTimeCost:3,
 argonParallelism:1,maxHashConcurrency:2,rateLimitWindowMs:900000,rateLimitMax:100};
const config:DocumentConfig={maxFileBytes:4096,maxConcurrentUploads:1,uploadTimeoutMs:1000,validationTimeoutMs:1000,
 maxImagePixels:1000,maxPdfPages:1,downloadExpirySeconds:60,uploadRateLimitMax:100,storage:null};
const body=Buffer.from('Synthetic original bytes: no patient data');
async function fixture(overrides:Partial<DocumentConfig>={}) {
 const patient=randomUUID(),other=randomUUID(),id=randomUUID();
 const row={id,original_filename:'synthetic.pdf',file_type:'pdf',category:'lab_report',hospital_name:'Synthetic Hospital',
 document_date:null,uploaded_at:new Date(),processing_status:'failed',sort_date:'2026-01-01',sort_date_source:'uploaded_at',
 s3_bucket:'synthetic-private-bucket',s3_object_key:'medical-documents/'+randomUUID()+'.pdf'};
 const state={reads:0,queries:0,signs:0,mode:'normal',replaced:false,removed:false,failQuery:false,
   entered:()=>{},closed:()=>{},queryHook:undefined as undefined|(()=>Promise<void>),hook:undefined as undefined|((signal:AbortSignal)=>Promise<void>)};
 const database:PatientDatabase={async query<R extends QueryResultRow>(sql:string,values:unknown[]){
  state.queries++;if(state.queryHook)await state.queryHook();assert.match(sql,/WHERE id = \$1 AND patient_id = \$2/);
  if(state.failQuery)throw new Error('SYNTHETIC_PRIVATE_DRIVER_DETAIL');
  return {rows:(values[0]===id&&values[1]===patient&&!state.removed?[{...row,...(state.replaced?{s3_object_key:'medical-documents/'+randomUUID()+'.pdf'}:{})}]:[]) as unknown as R[]};
 }};
 const storage:DocumentStorage={bucket:row.s3_bucket,prefix:'medical-documents/',
  async put(){throw Error('Unexpected upload');},async remove(){throw Error('Unexpected removal');},
  async download(){state.signs++;throw Error('URL signing forbidden');},
  async readOriginal(input){
   state.reads++;state.entered();
   if(state.hook)await state.hook(input.signal);
   if(state.mode==='failure')throw Error('SYNTHETIC_PRIVATE_STORAGE_DETAIL');
   if(state.mode==='symlink'){await symlink('/dev/null',input.destination);return {bytes:body.length};}
   if(state.mode==='missing')return {bytes:body.length};
   const bytes=state.mode==='oversize'?Buffer.alloc(5000):body;
   await writeFile(input.destination,bytes,{flag:'wx',mode:state.mode==='permissions'?0o644:0o600});
   if(state.mode==='permissions')await chmod(input.destination,0o644);
   if(state.mode==='removed')state.removed=true;
   if(state.mode==='replaced')state.replaced=true;
   if(state.mode==='database')state.failQuery=true;
   return {bytes:state.mode==='length'?body.length+1:bytes.length};
  }};
 const app=express();app.use(express.json());app.use((_req,res,next)=>{res.once('close',()=>state.closed());next();});app.use('/api/v1/patients',createPatientRoutes(database,auth).profile);app.use('/api/v1/documents',createDocumentRoutes(database,auth,{...config,...overrides},storage));app.use(errorHandler);
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');
 const base='http://127.0.0.1:'+address.port;
 const tokens=createTokenService(auth),own=await tokens.issue(patient),foreign=await tokens.issue(other);
 const request=(suffix='/'+id+'/download',token:string|undefined=own,extra:RequestInit={})=>fetch(base+'/api/v1/documents'+suffix,{...extra,headers:{...(token?{Authorization:'Bearer '+token}:{}),...extra.headers},signal:extra.signal??AbortSignal.timeout(5000)});
 return {state,row,id,own,foreign,storage,base,request,async close(){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
const temps=async()=>new Set((await readdir(tmpdir())).filter(n=>n.startsWith('health-wallet-file-')));
const unchanged=async(before:Set<string>)=>{for(let n=0;n<30;n++){const now=await temps();if([...now].every(x=>before.has(x)))return;await new Promise(r=>setTimeout(r,10));}assert.fail('Owned file temporary directory survived');};

test('B02 file URL possession requires a fresh authenticated request',async()=>{
 const f=await fixture();try{
  for(const token of ['', 'invalid']){const r=await f.request(undefined,token);assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');}
  assert.equal(f.state.reads,0);assert.equal(f.state.queries,0);
 }finally{await f.close();}
});
test('B02 foreign unknown and malformed document denials are identical and avoid storage',async()=>{
 const f=await fixture();try{
  const responses=[await f.request(undefined,f.foreign),await f.request('/'+randomUUID()+'/download'),await f.request('/not-a-uuid/download')];
  const values=[];for(const r of responses){assert.equal(r.status,404);values.push(await r.text());}
  assert.equal(new Set(values).size,1);assert.equal(f.state.reads,0);
 }finally{await f.close();}
});
for(const type of ['pdf','png','jpg','jpeg'])test('B02 authenticated '+type+' delivery preserves bytes and exposes no URL',async()=>{
 const before=await temps(),f=await fixture();f.row.file_type=type;f.row.original_filename='synthetic\r\nfilename.'+type;f.row.s3_object_key=f.row.s3_object_key.replace(/\.pdf$/,'.'+type);
 try{const r=await f.request();assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'private, no-store');
  assert.equal(r.headers.get('content-type'),type==='pdf'?'application/pdf':type==='png'?'image/png':'image/jpeg');
  assert.equal(r.headers.get('content-length'),String(body.length));assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  assert.equal(r.headers.get('location'),null);assert.ok(!r.headers.get('content-disposition')?.includes('\r'));
  assert.deepEqual(Buffer.from(await r.arrayBuffer()),body);assert.equal(f.state.signs,0);
  assert.equal(f.state.queries,2); // admission and pre-delivery ownership checks
 }finally{await f.close();await unchanged(before);}
});
for(const mode of ['failure','missing','symlink','oversize','permissions','length','replaced','database','removed'])test('B02 '+mode+' acquisition fails closed with private cleanup',async()=>{
 const before=await temps(),f=await fixture();f.state.mode=mode;
 try{const r=await f.request();assert.equal(r.status,mode==='removed'?404:503);const text=await r.text();assert.ok(!text.includes('SYNTHETIC_PRIVATE')&&!text.includes(f.row.s3_object_key));assert.equal(f.state.signs,0);}
 finally{await f.close();await unchanged(before);}
});
test('B02 invalid stored references never reach storage',async()=>{
 const f=await fixture();try{f.row.s3_object_key='../unrelated.pdf';assert.equal((await f.request()).status,503);assert.equal(f.state.reads,0);}finally{await f.close();}
});
test('B02 read endpoints reject unexpected selectors and bodies before database access',async()=>{
 const f=await fixture();try{
  for(const suffix of ['/'+f.id+'?patient_id='+randomUUID(),'/'+f.id+'/download?token=synthetic'])assert.equal((await f.request(suffix)).status,400);
  const {request}=await import('node:http');
  for(const suffix of ['', '/'+f.id, '/'+f.id+'/download']){
   const status=await new Promise<number>((resolve,reject)=>{
    const req=request(f.base+'/api/v1/documents'+suffix,{method:'GET',headers:{Authorization:'Bearer '+f.own,'Content-Type':'application/json','Content-Length':'2'}},res=>{res.resume();resolve(res.statusCode!);});
    req.on('error',reject);req.end('{}');
   });
   assert.equal(status,400);
  }
  assert.equal(f.state.queries,0);
 }finally{await f.close();}
});
test('B02 bounded download admission and release after completion',async()=>{
 const before=await temps(),f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);f.state.entered=entered;f.state.hook=async()=>gate;
 try{const first=f.request();await ready;const busy=await f.request();assert.equal(busy.status,503);assert.equal(busy.headers.get('retry-after'),'5');release();const r=await first;assert.equal(r.status,200);await r.arrayBuffer();await unchanged(before);f.state.hook=undefined;const again=await f.request();assert.equal(again.status,200);await again.arrayBuffer();}
 finally{release();await f.close();}
});
test('B02 acquisition deadline cancels storage and cleans temporary files',async()=>{
 const before=await temps(),f=await fixture();f.state.hook=async signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('synthetic cancelled')),{once:true}));
 try{const r=await f.request();assert.equal(r.status,503);await r.arrayBuffer();}finally{await f.close();await unchanged(before);}
});
test('B02 disconnected client cancels storage and releases resources',async()=>{
 const before=await temps(),f=await fixture();let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);f.state.entered=entered;
 f.state.hook=async signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('synthetic cancelled')),{once:true}));
 try{const controller=new AbortController();const pending=f.request(undefined,undefined,{signal:controller.signal});await ready;controller.abort();await assert.rejects(pending);await unchanged(before);f.state.hook=undefined;const next=await f.request();assert.equal(next.status,200);await next.arrayBuffer();}
 finally{await f.close();await unchanged(before);}
});
test('B02 authenticated file rate limit is patient scoped',async()=>{
 const f=await fixture({uploadRateLimitMax:1});try{let r=await f.request();assert.equal(r.status,200);await r.arrayBuffer();assert.equal((await f.request()).status,429);assert.equal((await f.request(undefined,f.foreign)).status,404);assert.equal(f.state.reads,1);}finally{await f.close();}
});

test('B02 older signer-only storage adapters cannot issue a public file URL',async()=>{
 const f=await fixture();delete f.storage.readOriginal;
 try{assert.equal((await f.request()).status,503);assert.equal(f.state.signs,0);}finally{await f.close();}
});

test('B02 profile read rejects a body before any profile database operation',async()=>{
 const f=await fixture();
 try{
  const {request}=await import('node:http');
  const status=await new Promise<number>((resolve,reject)=>{
   const req=request(f.base+'/api/v1/patients/me',{method:'GET',headers:{Authorization:'Bearer '+f.own,'Content-Type':'application/json','Content-Length':'2'}},res=>{res.resume();resolve(res.statusCode!);});
   req.on('error',reject);req.end('{}');
  });
  assert.equal(status,400);assert.equal(f.state.queries,0);
 }finally{await f.close();}
});

test('B02 disconnect during initial ownership query never starts storage acquisition',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 let closed!:()=>void;const disconnected=new Promise<void>(r=>closed=r);f.state.closed=closed;
 f.state.queryHook=async()=>{entered();await gate;};
 try{
  const controller=new AbortController();const pending=f.request(undefined,undefined,{signal:controller.signal});
  await ready;controller.abort();await assert.rejects(pending);await disconnected;release();
  await new Promise(r=>setTimeout(r,50));assert.equal(f.state.reads,0);
 }finally{release();await f.close();}
});
