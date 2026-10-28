import assert from "node:assert/strict";
import {randomUUID,randomBytes,createHash} from "node:crypto";
import {once} from "node:events";
import {readFile,readdir,stat,access} from "node:fs/promises";
import {dirname} from "node:path";
import {tmpdir} from "node:os";
import {Readable} from "node:stream";
import {setTimeout as delay} from "node:timers/promises";
import {test} from "node:test";
import sharp from "sharp";
import {S3Client} from "@aws-sdk/client-s3";
import {pool,closeDatabasePool} from "../database/pool.js";
import {getDocumentConfig,type S3StorageConfig} from "../config/documents.js";
import {getAuthenticationConfig} from "../config/auth.js";
import {createTokenService} from "../auth/tokens.js";
import {createApp} from "../app.js";
import {createS3Storage} from "../documents/storage.js";
import {createProcessingRepository,type Claim} from "./repository.js";
import {createProcessingService} from "./service.js";
import {getRetrievalConfig,type ProcessingConfig,type RetrievalConfig,ProcessingConfigurationError} from "./config.js";
import {InvalidProcessingClaim,InvalidProcessingInput,OriginalUnavailable,ProcessorFailure} from "./errors.js";
import {createOriginalAccess} from "./retrieval.js";
import {createProcessingWorker} from "./worker.js";

const aws:S3StorageConfig={bucket:'synthetic-private-originals',prefix:'medical-documents/',region:'us-east-1',ownerAccountId:'000000000000',encryption:'AES256'};
const lifecycle:ProcessingConfig={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:300000,heartbeatMs:15000,retryBaseMs:1000,retryMaxMs:10000,recoveryBatchSize:10};
const retrieval:RetrievalConfig={maxDownloadBytes:4096,downloadTimeoutMs:10000,leaseCheckIntervalMs:100,maxConcurrentRetrievals:2};
const docs=getDocumentConfig();
const signal=()=>new AbortController().signal;
function pdf(){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 40 40] /Resources << >> /Contents 4 0 R >>','<< /Length 4 >>\nstream\nq\nQ\nendstream'];
 let text='%PDF-1.7\n';const offsets=[0];for(const [i,o]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=(i+1)+' 0 obj\n'+o+'\nendobj\n';}
 const xref=Buffer.byteLength(text);text+='xref\n0 '+offsets.length+'\n0000000000 65535 f \n';for(const n of offsets.slice(1))text+=String(n).padStart(10,'0')+' 00000 n \n';
 return Buffer.from(text+'trailer\n<< /Size '+offsets.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n');
}
type Type='png'|'jpg'|'jpeg'|'pdf';
function mock(bytes:Buffer,type:Type='png',storageConfig:S3StorageConfig=aws){
 const calls:{name:string;input:Record<string,unknown>}[]=[];
 const state={mode:'normal',headLength:bytes.length,getLength:bytes.length,checksum:createHash('sha256').update(bytes).digest('base64'),
   encryption:'AES256',kmsKey:undefined as string|undefined,version:'synthetic-version' as string|undefined,etag:'"synthetic-etag"',mime:type==='pdf'?'application/pdf':type==='png'?'image/png':'image/jpeg',
   onGet:undefined as (()=>Promise<void>)|undefined,body:undefined as Readable|undefined};
 const client={async send(command:{constructor:{name:string};input:Record<string,unknown>},options:{abortSignal:AbortSignal}){
   const name=command.constructor.name;calls.push({name,input:command.input});
   assert.equal(command.input.Bucket,aws.bucket);assert.equal(command.input.ExpectedBucketOwner,aws.ownerAccountId);assert.ok(options.abortSignal);
   const metadata=()=>({ContentLength:state.headLength,ContentType:state.mime,ServerSideEncryption:state.encryption,SSEKMSKeyId:state.kmsKey,VersionId:state.version,ETag:state.etag});
   switch(name){
    case 'GetPublicAccessBlockCommand':return {PublicAccessBlockConfiguration:{BlockPublicAcls:state.mode!=='public',IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
    case 'GetBucketPolicyStatusCommand':return {PolicyStatus:{IsPublic:state.mode==='policy'}};
    case 'GetBucketOwnershipControlsCommand':return {OwnershipControls:{Rules:[{ObjectOwnership:state.mode==='ownership'?'ObjectWriter':'BucketOwnerEnforced'}]}};
    case 'GetBucketEncryptionCommand':return {ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:state.mode==='bucket-encryption'?'unsupported':state.encryption,KMSMasterKeyID:state.kmsKey}}]}};
    case 'HeadObjectCommand':if(state.mode==='missing')throw Object.assign(new Error('synthetic-private-error'),{name:'NoSuchKey'});return metadata();
    case 'GetObjectCommand':{
      if(state.onGet)await state.onGet();
      if(state.mode==='denied')throw Object.assign(new Error('synthetic-private-error'),{name:'AccessDenied'});
      if(state.mode==='late')await delay(150);
      const body=state.mode==='hung'?new Readable({read(){}}):state.mode==='interrupted'?Readable.from((async function*(){yield bytes.subarray(0,8);throw new Error('synthetic-private-error');})()):
        Readable.from([state.mode==='overflow'?Buffer.concat([bytes,Buffer.alloc(5000)]):state.mode==='truncated'?bytes.subarray(0,8):bytes]);
      state.body=body;
      return {...metadata(),ContentLength:state.getLength,Body:body,ChecksumSHA256:state.checksum,ChecksumType:'FULL_OBJECT'};
    }
    default:throw new Error('Unexpected mocked operation');
   }
 }} as unknown as S3Client;
 return {calls,state,storage:createS3Storage(storageConfig,{client,presign:async()=>{throw new Error('Internal reads must not presign');}})};
}

test('Phase 2.2B secure internal originals with mocked AWS',{timeout:180000},async t=>{
 const patients:string[]=[],documents:string[]=[];
 const beforeTemps=new Set((await readdir(tmpdir())).filter(n=>n.startsWith('health-wallet-processing-')));
 const png=await sharp({create:{width:3,height:3,channels:3,background:'white'}}).png().toBuffer();
 const jpeg=await sharp({create:{width:3,height:3,channels:3,background:'white'}}).jpeg().toBuffer();
 async function fixture(bytes=png,type:Type='png',active=true,settings:Partial<RetrievalConfig>={}){
   const patientId=randomUUID(),documentId=randomUUID();patients.push(patientId);
   await pool.query(`INSERT INTO public.patients(id,email,password_hash,full_name) VALUES($1,$2,$3,'Synthetic Retrieval Patient')`,[patientId,patientId+'@example.invalid','$argon2id$v=19$m=65536,t=3,p=1$syntheticSalt$syntheticHashNotAnActualPassword']);
   const key=aws.prefix+randomUUID()+'.'+type;
   await pool.query(`INSERT INTO public.medical_documents(id,patient_id,s3_bucket,s3_object_key,original_filename,file_type,category)
     VALUES($1,$2,$3,$4,$5,$6,'lab_report')`,[documentId,patientId,aws.bucket,key,'synthetic.'+type,type]);documents.push(documentId);
   const repository=createProcessingRepository(pool,lifecycle,patientId);const service=createProcessingService(repository);
   const job=active?await service.claim():undefined;
   const claim:Claim={documentId,patientId,token:job?.lease_token??randomUUID()};
   const sdk=mock(bytes,type);const config={...retrieval,...settings};
   const originals=createOriginalAccess(service,sdk.storage,docs,config);
   const use=(consume:Parameters<typeof originals.withOriginal>[2]=async input=>{assert.deepEqual(await readFile(input.path),bytes);},abortSignal=signal())=>originals.withOriginal(claim,abortSignal,consume);
   const expire=()=>pool.query("UPDATE public.document_processing_jobs SET lease_expires_at=clock_timestamp()-interval '1 millisecond' WHERE document_id=$1",[documentId]);
   return {patientId,documentId,key,claim,repository,service,sdk,config,originals,use,expire};
 }
 async function safeReject(operation:Promise<unknown>){await assert.rejects(operation,error=>{
   assert.ok(error instanceof Error);assert.ok(!error.message.includes('synthetic-private-error')&&!error.message.includes(aws.bucket)&&!error.message.includes(aws.prefix));return true;
 });}
 try{
   await t.test('active DB claim resolves only its owned original reference',async()=>{
     const f=await fixture();assert.deepEqual(await f.service.resolveOriginal(f.claim),{s3_bucket:aws.bucket,s3_object_key:f.key,file_type:'png'});
     assert.equal((await pool.query('SELECT current_user AS role')).rows[0].role,'health_wallet_app');
   });
   await t.test('pending job and malformed claim cannot authorize a reference',async()=>{
     const f=await fixture(png,'png',false);await assert.rejects(f.service.resolveOriginal(f.claim),InvalidProcessingClaim);
     await assert.rejects(f.service.resolveOriginal({...f.claim,token:'invalid'}),InvalidProcessingInput);assert.equal(f.sdk.calls.length,0);
   });
   await t.test('expired lease is denied before any AWS call',async()=>{
     const f=await fixture();await f.expire();await assert.rejects(f.use(),InvalidProcessingClaim);assert.equal(f.sdk.calls.length,0);
   });
   await t.test('expired hard attempt deadline is denied even with a forged future lease',async()=>{
     const f=await fixture();await pool.query("UPDATE public.document_processing_jobs SET attempt_deadline_at=clock_timestamp()-interval '1 second',lease_expires_at=clock_timestamp()-interval '2 seconds' WHERE document_id=$1",[f.documentId]);
     await assert.rejects(f.use(),InvalidProcessingClaim);assert.equal(f.sdk.calls.length,0);
   });
   await t.test('replaced lease token invalidates the old claim',async()=>{
     const f=await fixture();await pool.query('UPDATE public.document_processing_jobs SET lease_token=$1 WHERE document_id=$2',[randomUUID(),f.documentId]);
     await assert.rejects(f.use(),InvalidProcessingClaim);assert.equal(f.sdk.calls.length,0);
   });
   await t.test('incorrect patient and document associations cannot resolve private references',async()=>{
     const a=await fixture(),b=await fixture();
     for(const claim of [{...a.claim,patientId:b.patientId},{...a.claim,documentId:b.documentId},{...a.claim,token:b.claim.token}])await assert.rejects(a.originals.withOriginal(claim,signal(),async()=>{}),InvalidProcessingClaim);
     assert.equal(a.sdk.calls.length,0);
   });
   await t.test('successful direct SDK retrieval preserves bytes, ownership restrictions and private cleanup',async()=>{
     const f=await fixture();let path='';await f.use(async input=>{
       path=input.path;assert.deepEqual(await readFile(path),png);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal((await stat(dirname(path))).mode&0o777,0o700);
       assert.deepEqual(Object.keys(input).sort(),['assertActive','bytes','path','type']);await input.assertActive();
     });
     await assert.rejects(access(path));assert.ok(f.sdk.calls.some(c=>c.name==='GetObjectCommand'));
     const get=f.sdk.calls.find(c=>c.name==='GetObjectCommand')!.input;assert.equal(get.Key,f.key);assert.equal(get.VersionId,'synthetic-version');assert.equal(get.IfMatch,'"synthetic-etag"');
   });
   await t.test('PDF, JPG and JPEG originals reuse structural integrity validation',async()=>{
     for(const [type,bytes]of [['pdf',pdf()],['jpg',jpeg],['jpeg',jpeg]] as const){const f=await fixture(bytes,type);await f.use();}
   });
   await t.test('foreign bucket references are rejected before SDK access',async()=>{
     const f=await fixture();await pool.query("UPDATE public.medical_documents SET s3_bucket='synthetic-foreign-bucket' WHERE id=$1",[f.documentId]);await safeReject(f.use());assert.equal(f.sdk.calls.length,0);
   });
   await t.test('unsafe, traversal, wrong-prefix and unsupported extension keys never reach AWS',async()=>{
     for(const key of ['medical-documents/../../private.png','foreign/'+randomUUID()+'.png',aws.prefix+randomUUID()+'.exe',aws.prefix+randomUUID()+'.jpg']){
       const f=await fixture();await pool.query('UPDATE public.medical_documents SET s3_object_key=$1 WHERE id=$2',[key,f.documentId]);await safeReject(f.use());assert.equal(f.sdk.calls.length,0);
     }
   });
   await t.test('missing S3 originals fail generically without exposing storage details',async()=>{
     const f=await fixture();f.sdk.state.mode='missing';await safeReject(f.use());assert.ok(!f.sdk.calls.some(c=>c.name==='GetObjectCommand'));
   });
   await t.test('unsafe bucket public access, policy, ownership and encryption fail closed',async()=>{
     for(const mode of ['public','policy','ownership','bucket-encryption']){const f=await fixture();f.sdk.state.mode=mode;await safeReject(f.use());assert.ok(!f.sdk.calls.some(c=>c.name==='GetObjectCommand'));}
   });
   await t.test('mismatched object MIME or encryption is rejected before GET',async()=>{
     const f=await fixture();f.sdk.state.mime='application/octet-stream';await safeReject(f.use());assert.ok(!f.sdk.calls.some(c=>c.name==='GetObjectCommand'));
   });
   await t.test('approved SSE-KMS originals are retrieved with matching object encryption',async()=>{
     const f=await fixture();const keyArn='arn:aws:kms:us-east-1:000000000000:key/synthetic-key';
     const sdk=mock(png,'png',{...aws,encryption:'aws:kms',kmsKeyId:keyArn});sdk.state.encryption='aws:kms';sdk.state.kmsKey=keyArn;
     await createOriginalAccess(f.service,sdk.storage,docs,retrieval).withOriginal(f.claim,signal(),async input=>{assert.deepEqual(await readFile(input.path),png);});
     assert.ok(sdk.calls.some(c=>c.name==='GetObjectCommand'));
   });
   await t.test('object changes between HEAD and GET are rejected rather than consumed',async()=>{
     const f=await fixture();f.sdk.state.onGet=async()=>{f.sdk.state.version='different-synthetic-version';};let consumed=false;
     await safeReject(f.use(async()=>{consumed=true;}));assert.equal(consumed,false);assert.equal(f.sdk.state.body?.destroyed,true);
   });
   await t.test('oversized and empty advertised lengths are rejected before GET',async()=>{
     for(const length of [0,4097]){const f=await fixture();f.sdk.state.headLength=length;await safeReject(f.use());assert.ok(!f.sdk.calls.some(c=>c.name==='GetObjectCommand'));}
   });
   await t.test('unversioned objects require ETag-bound retrieval',async()=>{
     const f=await fixture();f.sdk.state.version=undefined;await f.use();const get=f.sdk.calls.find(c=>c.name==='GetObjectCommand')!.input;
     assert.equal(get.VersionId,undefined);assert.equal(get.IfMatch,'"synthetic-etag"');
   });
   await t.test('missing immutable object validator is rejected',async()=>{
     const f=await fixture();f.sdk.state.version=undefined;f.sdk.state.etag='';await safeReject(f.use());assert.ok(!f.sdk.calls.some(c=>c.name==='GetObjectCommand'));
   });
   await t.test('streaming byte overflow is rejected even when headers advertise a small file',async()=>{
     const f=await fixture();f.sdk.state.mode='overflow';await safeReject(f.use());assert.equal(f.sdk.state.body?.destroyed,true);
   });
   await t.test('truncated body and inconsistent GET length fail closed',async()=>{
     const f=await fixture();f.sdk.state.mode='truncated';await safeReject(f.use());
     const other=await fixture();other.sdk.state.getLength=png.length+1;await safeReject(other.use());assert.equal(other.sdk.state.body?.destroyed,true);
   });
   await t.test('full-object checksum corruption is rejected',async()=>{
     const f=await fixture();f.sdk.state.checksum=Buffer.alloc(32).toString('base64');await safeReject(f.use());
   });
   await t.test('structurally corrupted image never reaches the consumer',async()=>{
     const f=await fixture(Buffer.from('synthetic corrupt image'));let consumed=false;await safeReject(f.use(async()=>{consumed=true;}));assert.equal(consumed,false);
   });
   await t.test('interrupted streaming closes the body and removes private files',async()=>{
     const f=await fixture();f.sdk.state.mode='interrupted';await safeReject(f.use());assert.equal(f.sdk.state.body?.destroyed,true);
   });
   await t.test('S3 streaming timeout stops acquisition and destroys the pending body',async()=>{
     const f=await fixture(png,'png',true,{downloadTimeoutMs:150});f.sdk.state.mode='hung';await safeReject(f.use());assert.equal(f.sdk.state.body?.destroyed,true);
   });
   await t.test('a late GET response after timeout has its body destroyed',async()=>{
     const f=await fixture(png,'png',true,{downloadTimeoutMs:50});f.sdk.state.mode='late';await safeReject(f.use());await delay(200);assert.equal(f.sdk.state.body?.destroyed,true);
   });
   await t.test('cancellation during streaming removes temporary data before returning',async()=>{
     const f=await fixture();f.sdk.state.mode='hung';const controller=new AbortController();
     f.sdk.state.onGet=async()=>{setTimeout(()=>controller.abort(),20);};await safeReject(f.use(undefined,controller.signal));assert.equal(f.sdk.state.body?.destroyed,true);
   });
   await t.test('pre-aborted calls never resolve a reference or touch AWS',async()=>{
     const f=await fixture();const controller=new AbortController();controller.abort();await safeReject(f.use(undefined,controller.signal));assert.equal(f.sdk.calls.length,0);
   });
   await t.test('lease loss during GET prevents consumer handoff and stale completion',async()=>{
     const f=await fixture();f.sdk.state.onGet=async()=>{await f.expire();};let consumed=false;await safeReject(f.use(async()=>{consumed=true;}));
     assert.equal(consumed,false);assert.equal(await f.service.complete(f.claim),false);
   });
   await t.test('periodic DB checks cancel a stalled stream after lease replacement',async()=>{
     const f=await fixture();f.sdk.state.mode='hung';f.sdk.state.onGet=async()=>{await pool.query('UPDATE public.document_processing_jobs SET lease_token=$1 WHERE document_id=$2',[randomUUID(),f.documentId]);};
     await assert.rejects(f.use(),InvalidProcessingClaim);assert.equal(f.sdk.state.body?.destroyed,true);
   });
   await t.test('consumer failure and consumer cancellation both remove validated input',async()=>{
     const f=await fixture();let path='';await safeReject(f.use(async input=>{path=input.path;throw new Error('synthetic-private-error');}));await assert.rejects(access(path));
     const g=await fixture();const controller=new AbortController();await safeReject(g.use(async input=>{path=input.path;controller.abort();await new Promise(()=>{});},controller.signal));await assert.rejects(access(path));
   });
   await t.test('retrieval admission is bounded and released after consumer cleanup',async()=>{
     const f=await fixture(png,'png',true,{maxConcurrentRetrievals:1});let entered!:()=>void,release!:()=>void;
     const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
     const first=f.use(async()=>{entered();await gate;});await started;
     await assert.rejects(f.use(),OriginalUnavailable);release();await first;await f.use();
   });
   await t.test('worker supplies retrieval without starting automatically or claiming successful extraction',async()=>{
     const f=await fixture(png,'png',false);let path='';let consumed=false;
     const worker=createProcessingWorker(f.service,lifecycle,async({withOriginal})=>{await withOriginal(async input=>{path=input.path;assert.deepEqual(await readFile(path),png);consumed=true;});},f.originals);
     assert.equal(await worker.runOnce(),'failed');assert.equal(consumed,true);await assert.rejects(access(path));
     assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.extracted_medical_text WHERE document_id=$1',[f.documentId])).rows[0].n,0);
     assert.equal(await createProcessingWorker(f.service,lifecycle,undefined,f.originals).runOnce(),'disabled');
   });
   await t.test('worker cancellation waits for internal retrieval cleanup',async()=>{
     const f=await fixture(png,'png',false);f.sdk.state.mode='hung';const controller=new AbortController();
     f.sdk.state.onGet=async()=>{setTimeout(()=>controller.abort(),30);};
     const worker=createProcessingWorker(f.service,lifecycle,async({withOriginal})=>{await withOriginal(async()=>{});},f.originals);
     assert.equal(await worker.runOnce(controller.signal),'failed');assert.equal(f.sdk.state.body?.destroyed,true);
   });
   await t.test('internal references and retrieval routes are absent from public responses',async()=>{
     const f=await fixture(),other=await fixture();const auth={...getAuthenticationConfig(),jwtKey:new Uint8Array(randomBytes(32))};
     const app=createApp({auth,documentStorage:f.sdk.storage});const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
     try{
       for(const [patient,id,status]of [[f.patientId,f.documentId,200],[other.patientId,f.documentId,404]] as const){
         const response=await fetch(base+'/api/v1/documents/'+id,{headers:{Authorization:'Bearer '+await createTokenService(auth).issue(patient)}});assert.equal(response.status,status);
         const body=await response.text();for(const forbidden of [f.key,aws.bucket,f.claim.token,'lease_token','s3_object_key'])assert.ok(!body.includes(forbidden));
       }
       const token=await createTokenService(auth).issue(f.patientId);
       for(const route of ['/api/v1/processing','/api/v1/documents/'+f.documentId+'/original']){const response=await fetch(base+route,{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,404);await response.arrayBuffer();}
     }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
     assert.equal(f.sdk.calls.length,0);
   });
   await t.test('database resolver failure never initiates storage and contains no sensitive errors',async()=>{
     const f=await fixture();const service={...f.service,resolveOriginal:async()=>{throw new Error('synthetic-private-error');}};
     await safeReject(createOriginalAccess(service,f.sdk.storage,docs,retrieval).withOriginal(f.claim,signal(),async()=>{}));assert.equal(f.sdk.calls.length,0);
   });
   await t.test('retrieval configuration enforces bounded byte/time/concurrency values',()=>{
     const keys=['PROCESSING_MAX_DOWNLOAD_BYTES','PROCESSING_DOWNLOAD_TIMEOUT_MS','PROCESSING_LEASE_CHECK_INTERVAL_MS','PROCESSING_MAX_CONCURRENT_RETRIEVALS'];const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
     try{for(const key of keys){process.env[key]='0';assert.throws(getRetrievalConfig,ProcessingConfigurationError);if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
     finally{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
   });
   await t.test('all temporary processing directories created by this suite are gone',async()=>{
     assert.deepEqual((await readdir(tmpdir())).filter(n=>n.startsWith('health-wallet-processing-')&&!beforeTemps.has(n)),[]);
   });
 }finally{
   try{await pool.query('DELETE FROM public.document_processing_jobs WHERE document_id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.medical_documents WHERE id=ANY($1::uuid[])',[documents]);await pool.query('DELETE FROM public.patients WHERE id=ANY($1::uuid[])',[patients]);}
   finally{await closeDatabasePool();}
 }
});
