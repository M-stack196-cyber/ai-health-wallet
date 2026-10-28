import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,chmod,readFile,writeFile,rm,access} from 'node:fs/promises';
import {networkInterfaces} from 'node:os';
import {once} from 'node:events';
import {getDatabaseConfig} from '../config/env.js';
import {getDocumentConfig} from '../config/documents.js';
import {getProcessingConfig,getRetrievalConfig,getOcrConfig,getDigitalPdfConfig} from '../processing/config.js';
import {composeBackground} from '../processing/background-runtime-core.js';
import {createOcrProcessor} from '../processing/ocr-processor.js';
import {createApp} from '../app.js';
import {syntheticDigitalPdf} from '../processing/fixtures/pdf-fixtures.js';
import {syntheticScannedPdf} from '../processing/fixtures/ocr-fixtures.js';
import {canaryStorage,syntheticApi} from '../stage-c/adapters.js';
import {openJournal} from '../stage-c/evidence.js';
import {captureSnapshot,verifySnapshot} from '../stage-c/preservation.js';
import {runComposedCanary,type CanaryManifest,type LiveResources} from '../stage-c/live-composition.js';
import {target,type Preparation} from '../stage-c/safety.js';
import type {LiveOptions} from '../stage-c/runtime-flags.js';
import type {UnitStatus} from '../stage-c/supervision.js';
import type {AwsRead} from '../integration/guards.js';
import type {DocumentStorage} from '../documents/storage.js';
import type {OriginalStorage} from '../documents/original-reader.js';
const isolated=process.env.STAGE_B_RUN_ID;assert.match(isolated??'',/^stage-b-[a-f0-9]{24}$/);
assert.equal((await readFile('/stage-b-identity','utf8')).trim(),isolated);assert.ok(Object.entries(networkInterfaces()).every(([n,a])=>n==='lo'||!a?.length));
assert.equal((await readFile('/proc/net/route','utf8')).trim().split('\n').length,1);
const db=new pg.Pool({...getDatabaseConfig(),max:5,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000});
assert.equal((await db.query("SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()")).rows[0].marker,'stage-b:'+isolated);
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const aws:AwsRead=async(_s,op)=>{
 switch(op){case 'get-caller-identity':return {Account:target.account,Arn:'arn:aws:iam::'+target.account+':user/synthetic'};
 case 'get-bucket-location':return {LocationConstraint:target.region};case 'get-public-access-block':return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
 case 'get-bucket-policy-status':return {PolicyStatus:{IsPublic:false}};case 'get-bucket-ownership-controls':return {OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}};
 case 'get-bucket-encryption':return {ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]}};default:throw Error('Unexpected fake request');}
};
test('hardening adapters with isolated PostgreSQL, real API and OCR, fake S3 and supervisor',{timeout:90000},async t=>{
 const root=await mkdtemp('/tmp/stage-c-composition-');await chmod(root,0o700);const journal=await openJournal('/synthetic',root,async()=>{});
 const run='stage-c-'+randomBytes(12).toString('hex');
 const fixtures={sentinel:syntheticDigitalPdf([['SYNTHETIC STAGE C SENTINEL']]),mixed:await syntheticScannedPdf([{text:'SYNTHETIC STAGE C FIRST'},{scan:'SYNTHETIC STAGE C SECOND'}])};
 let manifest:CanaryManifest={version:2,run,target,stage:'seeding',patients:[],documents:[],uploads:[],fixtures:{sentinel:sha(fixtures.sentinel),mixed:sha(fixtures.mixed)},events:[]};
 const objects=new Map<string,Buffer>(),credentials:Record<string,unknown>={run};let puts=0,active=false,service:Awaited<ReturnType<typeof composeBackground>>|undefined;
 const paths:string[]=[];
 const base:DocumentStorage&OriginalStorage={bucket:target.bucket,prefix:target.prefix,
 async put(input){assert.ok(!objects.has(input.key));const bytes=await readFile(input.path);objects.set(input.key,bytes);puts++;return {versionId:'synthetic-v1'};},
 async remove(){throw Error('Deletion prohibited');},async download(){throw Error('Signing prohibited');},
 async readOriginal(input){const bytes=objects.get(input.key);assert.ok(bytes);paths.push(input.destination);await writeFile(input.destination,bytes,{mode:0o600,flag:'wx'});return {bytes:bytes.length};}};
 const guarded=canaryStorage(base,manifest.uploads,async()=>{await journal.save('manifest',manifest);await journal.save('receipts',{run,uploads:manifest.uploads,documents:manifest.documents});});
 const documents={...getDocumentConfig(),storage:{bucket:target.bucket,prefix:target.prefix,region:target.region,ownerAccountId:target.account,encryption:'AES256' as const}};
 const server=createApp({database:db,documentDatabase:db,documentConfig:documents,documentStorage:guarded.storage}).listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address();assert.ok(addr&&typeof addr==='object');const endpoint='http://127.0.0.1:'+addr.port;
 let api=syntheticApi(endpoint,run,fetch,async(role,c)=>{credentials[role]=c;await journal.save('credentials',credentials);});
 const options:LiveOptions={phase:'seed',run,evidenceDirectory:root,proofPath:root+'/unused-proof',proofSha256:'a'.repeat(64)};
 const unit={run,uid:1000,node:'/usr/bin/node',entry:'/synthetic/backend/dist/processing/background-entry.js',workingDirectory:'/synthetic/backend',environmentFile:root+'/worker.env',controllerUnit:'health-wallet-'+run+'-controller.service'};
 const status=():UnitStatus=>({id:'health-wallet-'+run+'.service',description:'AI Health Wallet '+run,uid:1000,transient:true,fragmentPath:'/run/user/1000/systemd/transient/health-wallet-'+run+'.service',
 restart:'no',type:'exec',execStart:[unit.node,unit.entry],bindsTo:[unit.controllerUnit],after:[unit.controllerUnit],cpuQuotaPerSecUSec:2000000,memoryMax:3221225472,tasksMax:128,runtimeMaxUSec:600000000,timeoutStopUSec:60000000,
 killMode:'mixed',killSignal:'SIGTERM',sendSIGKILL:true,noNewPrivileges:true,protectControlGroups:true,delegate:false,umask:'0077',active,mainPid:active?123:0,controlGroup:'/user.slice/user-1000.slice/user@1000.service/app.slice/health-wallet-'+run+'.service',populated:active,pids:active?[123]:[],effective:{cpuQuota:200000,cpuPeriod:100000,memoryMax:3221225472,pidsMax:128,readOnlyCgroupMount:true}});
 let p:Preparation|undefined;
 const resources:LiveResources={db,readAws:aws,signal:new AbortController().signal,now:Date.now,journal,manifest,fixture:role=>fixtures[role],api,expect:guarded.expect,unit,
 async original(role,id){const row=(await db.query('SELECT s3_object_key FROM public.medical_documents WHERE id=$1 AND patient_id=$2',[id,manifest.patients[0].id])).rows[0];assert.ok(row);const bytes=objects.get(row.s3_object_key);assert.ok(bytes);return {key:row.s3_object_key,sha256:sha(bytes),bytes:bytes.length,versionId:'synthetic-v1',unchanged:true,private:true,observedAt:new Date().toISOString()};},
 captureOldObjects:async()=>[],checkOldObjects:async value=>{assert.deepEqual(value,[]);},
 async noOtherService(){assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=1095259980 AND objid=2301 AND granted")).rows[0].n,0);},
 supervisor:{inspect:async()=>status(),async start(){assert.ok(p);assert.equal(active,false);const dedicated=new pg.Pool({...getDatabaseConfig(),max:4,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000});
 service=await composeBackground(p.config,{pool:dedicated,processing:{...getProcessingConfig(),maxAttempts:1},retrieval:getRetrievalConfig(),documents,storage:guarded.storage,
 processor:createOcrProcessor(getOcrConfig(),getDigitalPdfConfig()),profileUnchanged:async()=>{},closeStorage:()=>{},fault:()=>{throw Error('Isolated scheduler fault');},log:()=>{}});active=true;},
 async stop(){await service?.stop(true);service=undefined;active=false;}},
 async ready(signal){const end=Date.now()+10000;while(!service?.snapshot().ready){signal.throwIfAborted();assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,20));}},
 async cleanup(){for(const path of paths)await assert.rejects(access(path));assert.equal((await readFile('/proc/self/task/'+process.pid+'/children','utf8')).trim(),'');},
 async lockReleased(){assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=1095259980 AND objid=2301 AND granted")).rows[0].n,0);}};
 try{
 await t.test('seeding composes real authentication/upload, journals receipts and stops without scheduler',async()=>{await runComposedCanary(options,resources);assert.equal(active,false);assert.equal(manifest.stage,'seeded');assert.equal(manifest.patients.length,2);assert.equal(manifest.documents.length,1);assert.equal(puts,1);assert.ok(manifest.cutoff);});
 api.close();api=syntheticApi(endpoint,run,fetch);resources.api=api;
 const bytes=Buffer.from(JSON.stringify({version:1,mode:'canary',patientId:manifest.patients[0].id,uploadCutoff:manifest.cutoff,profile:target.profile,account:target.account,bucket:target.bucket,region:target.region}));await writeFile(root+'/approval.json',bytes,{mode:0o600});
 p={run,controlPatientId:manifest.patients[1].id,config:{enabled:true,canary:{patientId:manifest.patients[0].id,uploadCutoff:manifest.cutoff!},concurrency:1,pollMs:2000,backoffMaxMs:30000,drainMs:30000,healthPort:0,approvalPath:root+'/approval.json',approvalSha256:sha(bytes)}};
 resources.baseline=(await journal.read('baseline')).rows;
 await t.test('activation reauthenticates seeded identities, auto processes mixed PDF and restarts idle',async()=>{
  await runComposedCanary({...options,phase:'activate',preparation:p},resources);assert.equal(manifest.stage,'completed');assert.equal(puts,2);assert.equal(active,false);
  const rows=(await db.query(`SELECT d.processing_status,j.state,j.attempt_count,(SELECT count(*)::int FROM public.extracted_medical_text WHERE document_id=d.id) AS n FROM public.medical_documents d JOIN public.document_processing_jobs j ON j.document_id=d.id WHERE d.patient_id=$1 ORDER BY d.uploaded_at`,[manifest.patients[0].id])).rows;
  assert.deepEqual(rows,[{processing_status:'processing',state:'pending',attempt_count:0,n:0},{processing_status:'completed',state:'completed',attempt_count:1,n:1}]);
 });
 await t.test('completed or ambiguous runs cannot repeat registration or upload',async()=>{await assert.rejects(runComposedCanary({...options,phase:'activate',preparation:p},resources));assert.equal(puts,2);});
 await t.test('real snapshot comparison detects changes outside approved row IDs',async()=>{
  const before=await captureSnapshot(db);await db.query("UPDATE public.patients SET full_name='Synthetic modified' WHERE id=$1",[manifest.patients[1].id]);const after=await captureSnapshot(db);assert.throws(()=>verifySnapshot(before,after,[],[],[]));
 });
 }finally{await service?.stop(true);api.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  const ids=manifest.documents.map(d=>d.id);await db.query('DELETE FROM public.extracted_medical_text WHERE document_id=ANY($1::uuid[])',[ids]);await db.query('DELETE FROM public.medical_documents WHERE id=ANY($1::uuid[])',[ids]);await db.query('DELETE FROM public.patients WHERE id=ANY($1::uuid[])',[manifest.patients.map(v=>v.id)]);await db.end();await rm(root,{recursive:true,force:true});}
});
