import {randomUUID} from 'node:crypto';
import {readFile,readdir,mkdir,unlink,lstat} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import type {Server} from 'node:http';
import {guard} from '../processing/background-config.js';
import {checkEnvironment} from '../integration/guards.js';
import {loadPinnedProfile,awsReadFor} from '../integration/aws-preflight.js';
import {freshPreflight,target,checkPreparation} from './safety.js';
import {openJournal,checkIgnored} from './evidence.js';
import {createPrivate,readPrivate} from './private-files.js';
import {localProofIdentity,verifySupervisionProof,digest} from './proof.js';
import {canaryStorage,syntheticApi} from './adapters.js';
import {createSystemdSupervisor,localCommand} from './systemd-adapter.js';
import {runComposedCanary,validateManifest,type CanaryManifest,type LiveResources} from './live-composition.js';
import {type UnitPlan} from './supervision.js';
import {inspectInside,validateInside} from './inside-protection.js';
import {assertRuntimeApproval,type LiveOptions} from './runtime-flags.js';
import {isBackgroundCommand,serializeEnvironment} from './runtime-policies.js';
const canonical=(v:unknown)=>JSON.stringify(v);
async function noFile(path:string){try{await lstat(path);throw Error('Existing run refused');}catch(e){guard((e as NodeJS.ErrnoException).code==='ENOENT');}}
export async function runLiveController(options:LiveOptions,signal:AbortSignal){
 assertRuntimeApproval(options);signal.throwIfAborted();
 // Parse/approval has already happened in CLI. Local proofs precede all external
 // work, even read-only AWS requests or constructing the API/PG dependencies.
 const backend=resolve(fileURLToPath(new URL('../../',import.meta.url))),project=dirname(backend);
 const evidence=resolve(options.evidenceDirectory);await checkIgnored(project,evidence+'/manifest.json');
 const journal=await openJournal(project,evidence);await verifySupervisionProof(options.proofPath,options.proofSha256,await localProofIdentity());
 if(options.phase==='activate'){
  await checkPreparation(options.preparation!);
  // Controller itself must be the approved bounded user service, not a shell.
  const inside=await inspectInside();validateInside(inside,'/user.slice/user-'+process.getuid!()+'.slice/user@'+process.getuid!()+'.service/app.slice/health-wallet-'+options.run+'-controller.service');
  const output=await localCommand('systemctl',['--user','show','health-wallet-'+options.run+'-controller.service','--property=Transient,Restart,RuntimeMaxUSec,MemoryMax,TasksMax,CPUQuotaPerSecUSec,MainPID','--value']);
  // Query individually to avoid assumptions about systemctl property ordering.
  const prop=async(name:string)=>localCommand('systemctl',['--user','show','health-wallet-'+options.run+'-controller.service','--property='+name,'--value']);
  guard(output&&await prop('Transient')==='yes'&&await prop('Restart')==='no'&&await prop('MainPID')===String(process.pid));
  guard(await prop('RuntimeMaxUSec')==='15min'&&await prop('MemoryMax')==='805306368'&&await prop('TasksMax')==='64'&&await prop('CPUQuotaPerSecUSec')==='500ms');
 }
 let manifest:CanaryManifest;
 if(options.phase==='seed'){await noFile(evidence+'/manifest.json');await noFile(evidence+'/credentials.json');manifest={version:2,run:options.run,target,stage:'seeding',patients:[],documents:[],uploads:[],fixtures:{sentinel:'',mixed:''},events:[]};}
 else{manifest=await journal.read('manifest');guard(manifest.stage==='seeded');}
 validateManifest(options,manifest);
 if(options.phase==='activate'){const receipts=await journal.read('receipts'),baseline=await journal.read('baseline'),credentials=await journal.read('credentials');guard(receipts.run===options.run&&baseline.run===options.run&&credentials.run===options.run&&baseline.rows&&credentials.canary&&credentials.control);}
 await import('../config/env.js');checkEnvironment(process.env);guard((process.env.PROCESSING_SERVICE_ENABLED??'false')==='false');
 const profile=await loadPinnedProfile(),readAws=awsReadFor(profile);await freshPreflight(readAws);signal.throwIfAborted();
 const [{S3Client,HeadObjectCommand},{createS3Storage},{syntheticDigitalPdf},{syntheticScannedPdf},pg,env,docs]=await Promise.all([
  import('@aws-sdk/client-s3'),import('../documents/storage.js'),import('../processing/fixtures/pdf-fixtures.js'),import('../processing/fixtures/ocr-fixtures.js'),import('pg'),import('../config/env.js'),import('../config/documents.js')]);
 const config=docs.getDocumentConfig();guard(config.storage);
 const connectionLoss=new AbortController();signal=AbortSignal.any([signal,connectionLoss.signal]);
 const pool=new pg.default.Pool({...env.getDatabaseConfig(),max:3,connectionTimeoutMillis:3000,statement_timeout:3000,query_timeout:5000});
 pool.on('error',()=>connectionLoss.abort());
 const sdk=new S3Client({region:target.region,credentials:profile.credentials,maxAttempts:1,ignoreConfiguredEndpointUrls:true,requestHandler:{connectionTimeout:3000,requestTimeout:10000}});
 const client={async send(command:unknown,opts?:unknown){await profile.unchanged();try{return await sdk.send(command as never,opts as never);}finally{await profile.unchanged();}}} as unknown as InstanceType<typeof S3Client>;
 let server:Server|undefined,api:ReturnType<typeof syntheticApi>|undefined;const savedTmp=process.env.TMPDIR;
 const runtime=evidence+'/runtime',workerTemp=evidence+'/worker-temp';
 const fixtures=new Map<'sentinel'|'mixed',Buffer>();const stateCredentials:Record<string,unknown>={run:options.run};
 const uploadSave=async()=>{await journal.save('manifest',manifest);await journal.save('receipts',{run:manifest.run,uploads:manifest.uploads,documents:manifest.documents});};
 try{
  const bytes=options.phase==='seed'?{sentinel:syntheticDigitalPdf([['SYNTHETIC STAGE C SENTINEL']]),mixed:await syntheticScannedPdf([{text:'SYNTHETIC STAGE C FIRST'},{scan:'SYNTHETIC STAGE C SECOND'}])}:undefined;
  for(const role of ['sentinel','mixed'] as const){
   const path=evidence+'/'+role+'.pdf';if(bytes){guard(bytes[role].length<=1048576);await createPrivate(path,bytes[role]);manifest.fixtures[role]=digest(bytes[role]);}
   const value=await readPrivate(path);guard(digest(value)===manifest.fixtures[role]);fixtures.set(role,value);
  }
  if(options.phase==='seed'){await mkdir(runtime,{mode:0o700});await mkdir(workerTemp,{mode:0o700});await journal.save('manifest',manifest);}
  else{for(const path of [runtime,workerTemp]){const s=await lstat(path);guard(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid!()&&(s.mode&0o777)===0o700&&(await readdir(path)).length===0);}}
  process.env.TMPDIR=runtime;
  const guarded=canaryStorage(createS3Storage(config.storage,{client}),manifest.uploads,uploadSave);
  const {createApp}=await import('../app.js');const app=createApp({database:pool,documentDatabase:pool,documentConfig:config,documentStorage:guarded.storage});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();guard(address&&typeof address==='object');
  api=syntheticApi('http://127.0.0.1:'+address.port,options.run,fetch,async(role,c)=>{guard(!stateCredentials[role]);stateCredentials[role]=c;await journal.save('credentials',stateCredentials);});
  const head=async(key:string,versionId?:string)=>{
   guard(/^medical-documents\/[a-f0-9-]{36}\.(pdf|png|jpg|jpeg)$/.test(key));
   const h=await client.send(new HeadObjectCommand({Bucket:target.bucket,Key:key,ExpectedBucketOwner:target.account,VersionId:versionId}),{abortSignal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
   return {key,versionId:h.VersionId,etag:h.ETag,bytes:h.ContentLength,mime:h.ContentType,encryption:h.ServerSideEncryption,modified:h.LastModified?.toISOString()};
  };
  const oldObjects=async()=>{
   const rows=(await pool.query('SELECT DISTINCT s3_bucket,s3_object_key FROM public.medical_documents ORDER BY s3_bucket,s3_object_key LIMIT 1001')).rows;guard(rows.length<=1000);
   const heads=[];for(const r of rows){guard(r.s3_bucket===target.bucket&&r.s3_object_key.startsWith(target.prefix));heads.push(await head(r.s3_object_key));}return heads;
  };
  const noOtherService=async()=>{
   guard((await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND granted",[1095259980,2301])).rows[0].n===0);
   for(const name of await readdir('/proc'))if(/^\d+$/.test(name))try{const cmd=await readFile('/proc/'+name+'/cmdline','utf8');guard(!isBackgroundCommand(cmd));}catch(e){if(!['ENOENT','EACCES','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))throw e;}
  };
  const p=options.preparation;
  const unit:UnitPlan={run:options.run,uid:process.getuid!(),node:process.execPath,entry:backend+'/dist/processing/background-entry.js',workingDirectory:backend,
   environmentFile:evidence+'/worker.env',controllerUnit:'health-wallet-'+options.run+'-controller.service',insideReport:evidence+'/service-inside.json'};
  async function compiledFiles(dir:string):Promise<string[]>{const files:string[]=[];for(const item of await readdir(dir,{withFileTypes:true})){guard(!item.isSymbolicLink());const path=join(dir,item.name);if(item.isDirectory())files.push(...await compiledFiles(path));else if(item.isFile()&&item.name.endsWith('.js'))files.push(path);}return files.sort();}
  const artifactPaths=[...await compiledFiles(backend+'/dist'),backend+'/package-lock.json'];
  const artifacts:Record<string,string>={};for(const path of artifactPaths)artifacts[path]=digest(await readFile(path));
  if(options.phase==='seed'){manifest.artifacts=artifacts;await uploadSave();}else guard(canonical(manifest.artifacts)===canonical(artifacts));
  const healthPort=5001;
  let launchHash='';
  if(options.phase==='activate'){
   const launch:Record<string,string>={};
   for(const [key,value]of Object.entries(process.env))if(value&&(/^(DB_|S3_|OCR_|PDF_TEXT_|PROCESSING_)/.test(key)||['AWS_PROFILE','AWS_REGION','DOCUMENT_STORAGE_ENABLED'].includes(key)))launch[key]=value;
   Object.assign(launch,{PROCESSING_SERVICE_ENABLED:'true',PROCESSING_SERVICE_MODE:'canary',PROCESSING_SERVICE_CONCURRENCY:'1',PROCESSING_SERVICE_POLL_MS:'2000',PROCESSING_SERVICE_DRAIN_MS:'30000',PROCESSING_MAX_ATTEMPTS:'1',
    PROCESSING_CANARY_PATIENT_ID:p!.config.canary.patientId,PROCESSING_UPLOAD_CUTOFF:p!.config.canary.uploadCutoff,PROCESSING_APPROVAL_FILE:p!.config.approvalPath,PROCESSING_APPROVAL_SHA256:p!.config.approvalSha256,
    PROCESSING_SERVICE_HEALTH_PORT:String(healthPort),TMPDIR:workerTemp});
   const text=serializeEnvironment(launch);await createPrivate(unit.environmentFile,text);launchHash=digest(text);
  }
  const insideReceipts:unknown[]=[];
  const supervisor=createSystemdSupervisor(unit,async()=>{
   guard(p);await checkPreparation(p);await profile.unchanged();guard(digest(await readPrivate(unit.environmentFile))===launchHash);
   for(const [path,sha]of Object.entries(artifacts))guard(digest(await readFile(path))===sha);
  },async receipt=>{if(!insideReceipts.some(v=>canonical(v)===canonical(receipt))){insideReceipts.push(receipt);await journal.save('supervision',{run:options.run,artifacts,insideReceipts});}});
  const ready=async(s:AbortSignal)=>{
   const deadline=Date.now()+30000;while(true){s.throwIfAborted();const status=await supervisor.inspect();guard(status.active);
    try{await supervisor.ownsHealth(healthPort);const response=await fetch('http://127.0.0.1:'+healthPort+'/ready',{signal:AbortSignal.any([s,AbortSignal.timeout(1000)]),redirect:'error'});if(response.status===200&&(await response.json() as {ready:boolean}).ready===true){const metrics=await fetch('http://127.0.0.1:'+healthPort+'/metrics',{signal:AbortSignal.any([s,AbortSignal.timeout(1000)]),redirect:'error'});const value=await metrics.json() as Record<string,number>;guard(metrics.status===200&&value.queue===0&&value.active===0&&value.failed===0&&value.lost===0&&value.unavailable===0);return;}}catch{}
    guard(Date.now()<deadline);await new Promise(r=>setTimeout(r,250));
   }
  };
  const baseline=options.phase==='activate'?(await journal.read('baseline')).rows:undefined;
  const original=async(role:'sentinel'|'mixed',id:string)=>{
   const u=manifest.uploads.find(v=>v.scenario===(role==='sentinel'?'A':'C'));guard(u?.confirmed);
   const d=(await pool.query('SELECT s3_object_key FROM public.medical_documents WHERE id=$1 AND patient_id=$2',[id,manifest.patients[0].id])).rows;guard(d.length===1&&d[0].s3_object_key===u.key);
   const before=await head(u.key,u.versionId);
   manifest.originals??={};if(manifest.originals[role])guard(canonical(manifest.originals[role])===canonical(before));else{manifest.originals[role]=before;await uploadSave();}
   guard(before.versionId===u.versionId&&before.bytes===u.bytes&&before.mime===u.mime&&before.encryption==='AES256'&&!!before.etag);
   const path=join(runtime,'read-'+randomUUID()+'.pdf');let sha='';try{await guarded.storage.readOriginal({key:u.key,type:'pdf',destination:path,maxBytes:1048576,timeoutMs:15000,signal});sha=digest(await readFile(path));}finally{await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});}
   const after=await head(u.key,u.versionId);guard(canonical(before)===canonical(after));
   const anonymous=await fetch('https://'+target.bucket+'.s3.'+target.region+'.amazonaws.com/'+u.key,{headers:{Range:'bytes=0-0'},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});await anonymous.body?.cancel();guard([403,404].includes(anonymous.status));
   if(role==='mixed'){
    const text=(await pool.query('SELECT extracted_text FROM public.extracted_medical_text WHERE document_id=$1 AND patient_id=$2',[id,manifest.patients[0].id])).rows;
    if(text.length){const value=text[0].extracted_text as string;guard(value.indexOf('SYNTHETIC STAGE C FIRST')>=0&&value.indexOf('SYNTHETIC STAGE C SECOND')>value.indexOf('SYNTHETIC STAGE C FIRST'));}
   }
   return {key:u.key,sha256:sha,bytes:u.bytes,versionId:u.versionId,unchanged:canonical(before)===canonical(after),private:true,observedAt:new Date().toISOString()};
  };
  const resources:LiveResources={db:pool,readAws,signal,now:Date.now,journal,manifest,baseline,fixture:role=>fixtures.get(role)!,api,expect:guarded.expect,original,unit,supervisor,noOtherService,ready,
   captureOldObjects:oldObjects,async checkOldObjects(value){guard(Array.isArray(value));for(const item of value){guard(item&&typeof item.key==='string');guard(canonical(await head(item.key,item.versionId))===canonical(item));}},
   async cleanup(){guard((await readdir(workerTemp)).length===0&&(await readdir(runtime)).length===0);},lockReleased:noOtherService};
  await runComposedCanary(options,resources);
  await journal.save('verification',{run:options.run,phase:options.phase,passed:true,retained:true});
 }finally{
  api?.close();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}
  if(savedTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=savedTmp;
  sdk.destroy();await pool.end();const {closeDatabasePool}=await import('../database/pool.js');await closeDatabasePool();await journal.flush();
 }
}
