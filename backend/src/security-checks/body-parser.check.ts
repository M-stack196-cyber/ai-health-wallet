import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,cp,symlink,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {request as httpRequest} from 'node:http';
import {gzipSync,deflateSync,brotliCompressSync} from 'node:zlib';
import express from 'express';
import {errorHandler} from '../http/errors.js';
import {parseUpload} from '../documents/multipart.js';

async function listen(app:ReturnType<typeof express>){const server=app.listen(0,'127.0.0.1');await once(server,'listening');const a=server.address();assert.ok(a&&typeof a==='object');return {server,url:'http://127.0.0.1:'+a.port};}
async function close(server:ReturnType<ReturnType<typeof express>['listen']>){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
const documentConfig={maxFileBytes:4096,maxConcurrentUploads:2,uploadTimeoutMs:3000,validationTimeoutMs:1000,maxImagePixels:1000,maxPdfPages:1,downloadExpirySeconds:60,uploadRateLimitMax:1000,storage:null};

test('BP-01 JSON parsing, compression, malformed/oversized/unsupported bodies and continued availability',async()=>{
 const app=express();app.use(express.json({limit:'100kb'}));app.get('/health',(_req,res)=>res.json({ready:true}));app.post('/echo',(req,res)=>res.json({body:req.body??null}));app.use(errorHandler);const {server,url}=await listen(app);
 const send=(body:Buffer|string,headers:Record<string,string>={})=>fetch(url+'/echo',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:new Uint8Array(Buffer.from(body)),signal:AbortSignal.timeout(5000)});
 try{
  const data={email:'synthetic@example.invalid',nested:{value:1}};const plain=JSON.stringify(data);
  for(const [encoding,body] of [['identity',Buffer.from(plain)],['gzip',gzipSync(plain)],['deflate',deflateSync(plain)],['br',brotliCompressSync(plain)]] as const){const r=await send(body,{'Content-Encoding':encoding});assert.equal(r.status,200);assert.deepEqual((await r.json()).body,data);}
  assert.equal((await send('{broken')).status,400);assert.equal((await send(JSON.stringify({payload:'x'.repeat(103000)}))).status,413);assert.equal((await send('{}',{'Content-Encoding':'unknown'})).status,415);
  const bad=await send(Buffer.from('not a gzip stream'),{'Content-Encoding':'gzip'});assert.equal(bad.status,500);assert.deepEqual((await bad.json()).error,{code:'INTERNAL_ERROR',message:'Request could not be completed.'});
  assert.equal((await fetch(url+'/health')).status,200);
 }finally{await close(server);}
});

test('BP-02 delayed trailing bytes after compressed JSON do not terminate the process',async()=>{
 const app=express();app.use(express.json());app.post('/echo',(req,res)=>res.json({accepted:true}));app.get('/health',(_req,res)=>res.json({ready:true}));app.use(errorHandler);const {server,url}=await listen(app);
 try{for(let i=0;i<5;i++){
  const status=await new Promise<number>((resolve,reject)=>{
   const req=httpRequest(url+'/echo',{method:'POST',headers:{'Content-Type':'application/json','Content-Encoding':'gzip'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode!));});
   req.once('error',reject);req.setTimeout(5000,()=>req.destroy(Error('Synthetic request timeout')));req.write(gzipSync('{"synthetic":true}'));setTimeout(()=>req.end(Buffer.from('trailing-invalid-compressed-bytes')),25);
  });assert.ok([200,400,500].includes(status));await new Promise(r=>setTimeout(r,40));assert.equal((await fetch(url+'/health')).status,200);
 }}finally{await close(server);}
});

test('BP-03 JSON middleware leaves multipart upload parsing and bytes intact',async()=>{
 const app=express();app.use(express.json({limit:'100kb'}));app.post('/upload',async(req,res)=>{const parsed=await parseUpload(req,documentConfig,new AbortController().signal);try{res.json({name:parsed.name,bytes:parsed.bytes,category:parsed.metadata.category});}finally{await parsed.dispose();}});app.use(errorHandler);const {server,url}=await listen(app);
 try{const form=new FormData();form.append('file',new Blob([Buffer.from('%PDF-1.7\nsynthetic fixture')],{type:'application/pdf'}),'fixture.pdf');form.append('category','lab_report');form.append('hospital_name','Synthetic Hospital');const r=await fetch(url+'/upload',{method:'POST',body:form,signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);assert.deepEqual(await r.json(),{name:'fixture.pdf',bytes:26,category:'lab_report'});}finally{await close(server);}
});

test('BP-04 actual compiled application starts with synthetic configuration and rejects invalid route bodies safely',async()=>{
 // Copy compiled code without .env: no application credentials or live configuration are loaded.
 const dir=await mkdtemp(join(tmpdir(),'hw-body-parser-')),saved={...process.env};let running:Awaited<ReturnType<typeof listen>>|undefined,closePool:(()=>Promise<void>)|undefined;
 try{
  await cp(new URL('../../dist/',import.meta.url),join(dir,'dist'),{recursive:true});await symlink(fileURLToPath(new URL('../../node_modules/',import.meta.url)),join(dir,'node_modules'));await writeFile(join(dir,'package.json'),' {"type":"module"}\n');
  Object.assign(process.env,{DB_HOST:dir,DB_PORT:'55481',DB_NAME:'unused_synthetic',DB_USER:'health_wallet_app',DB_PASSWORD:'synthetic-unused',JWT_SECRET:randomBytes(32).toString('hex'),DOCUMENT_STORAGE_ENABLED:'false',AUTH_SECURITY_EMAIL_MODE:'disabled',SHARING_PUBLIC_ORIGIN:''});
  const {createApp}=await import(pathToFileURL(join(dir,'dist/app.js')).href);closePool=(await import(pathToFileURL(join(dir,'dist/database/pool.js')).href)).closeDatabasePool;
  const denyDatabase={async query(){throw Error('No database access permitted in parser/startup check.');}};
  running=await listen(createApp({database:denyDatabase,documentDatabase:denyDatabase,documentStorage:null,identity:{},sharing:{},rag:{}}));const url=running.url;
  assert.equal((await fetch(url+'/api/v1/health')).status,200);
  for(const path of ['/auth/login','/auth/register','/guardian-invitations/accept']){const r=await fetch(url+'/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{broken'});assert.equal(r.status,400);}
  assert.equal((await fetch(url+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,400);
  assert.equal((await fetch(url+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'email=synthetic%40example.invalid'})).status,415);
  for(const path of ['/patients/me/guardian','/documents','/sharing/grants'])assert.equal((await fetch(url+'/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert.equal((await fetch(url+'/api/v1/doctor/records')).status,503); // sharing intentionally disabled
 }finally{if(running)await close(running.server);await closePool?.();for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);await rm(dir,{recursive:true,force:true});}
});
