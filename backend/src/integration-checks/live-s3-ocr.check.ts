import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFlags,checkEnvironment,target,preflight,RunRegistry,createGuardedStorage,VerificationFailure,assertPreserved,type Options,type Scenario,type AwsRead,type RecordOfUpload} from '../integration/guards.js';
import {selectProfile,createAwsRead,classifyAwsFailure} from '../integration/aws-preflight.js';
import {executeScenarios,type ScenarioPorts} from '../integration/workflow.js';
import {createScenarioWorker} from '../integration/scoped-worker.js';
import {createDocumentService} from '../documents/service.js';
import type {createDocumentRepository} from '../documents/repository.js';
import type {DocumentStorage} from '../documents/storage.js';
import type {OriginalStorage} from '../documents/original-reader.js';

const args=['--profile',target.profile,'--account',target.account,'--bucket',target.bucket,'--region',target.region];
const live:Options=parseFlags(['--run','--approve-live-writes',...args]),readOnly=parseFlags(['--preflight',...args]);
const env={AWS_PROFILE:target.profile,AWS_REGION:target.region,DOCUMENT_STORAGE_ENABLED:'true',S3_BUCKET:target.bucket,S3_BUCKET_OWNER_ACCOUNT_ID:target.account,DB_HOST:'127.0.0.1',DB_PORT:'5433',DB_NAME:'ai_health_wallet',DB_USER:'health_wallet_app'};
const good:AwsRead=async(service,operation)=>{
 if(service==='sts')return {Account:target.account,Arn:`arn:aws:iam::${target.account}:user/synthetic-test-user`};
 if(operation==='get-bucket-location')return {LocationConstraint:target.region};
 if(operation==='get-public-access-block')return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
 if(operation==='get-bucket-policy-status')return {PolicyStatus:{IsPublic:false}};
 if(operation==='get-bucket-ownership-controls')return {OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}};
 return {ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]}};
};
function ports(){
 const calls:string[]=[],ids=new Map<Scenario,string>();
 const value:ScenarioPorts={async prepare(){calls.push('prepare');},async register(s){calls.push('register:'+s);const id=randomUUID();ids.set(s,id);return id;},
 async upload(s,p){assert.equal(p,ids.get(s));calls.push('upload:'+s);return randomUUID();},async process(scope,registry){registry.assert(scope);assert.equal(scope.patientId,ids.get(scope.scenario));calls.push('process:'+scope.scenario);},
 async verify(scope){calls.push('verify:'+scope.scenario);},async preserve(){calls.push('preserve');},async close(){calls.push('close');}};
 return {calls,value};
}
test('manual S3/OCR runner safety; fake AWS/database only',async t=>{
 await t.test('preflight and live modes require complete explicit exact-target flags',()=>{
  assert.equal(readOnly.mode,'preflight');assert.equal(live.mode,'run');
  for(const a of [[],args,['--run',...args],['--preflight','--approve-live-writes',...args],['--preflight','--run',...args],['--preflight',...args,'--cleanup'],['--preflight',...args,'--profile',target.profile]])assert.throws(()=>parseFlags(a),VerificationFailure);
 });
 for(const key of ['--profile','--account','--bucket','--region'])await t.test(`wrong ${key} cannot reach a port`,()=>{
  const a=['--preflight',...args];a[a.indexOf(key)+1]='default-or-unrelated';assert.throws(()=>parseFlags(a),VerificationFailure);
 });
 await t.test('runtime configuration matches every approved target setting',()=>{
  checkEnvironment(env);for(const key of Object.keys(env))assert.throws(()=>checkEnvironment({...env,[key]:'wrong'}),VerificationFailure);
  for(const key of ['S3_DOCUMENT_PREFIX','S3_ENCRYPTION','S3_KMS_KEY_ARN'])assert.throws(()=>checkEnvironment({...env,[key]:'unexpected'}),VerificationFailure);
 });
 await t.test('ambient credentials, proxies, alternate files and endpoints fail closed',()=>{
  for(const key of ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_DEFAULT_PROFILE','AWS_WEB_IDENTITY_TOKEN_FILE','AWS_ROLE_ARN','AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE','AWS_ENDPOINT_URL','AWS_ENDPOINT_URL_S3','HTTPS_PROXY'])assert.throws(()=>checkEnvironment({...env,[key]:'SYNTHETIC_DO_NOT_PRINT'}),VerificationFailure);
 });
 await t.test('profile selector never falls back to default or a source profile',()=>{
  assert.deepEqual(selectProfile('[default]\nregion=unrelated\n[profile ai-health-wallet]\nregion=ap-southeast-2\n','profile ai-health-wallet',['region']),{region:target.region});
  for(const text of ['[default]\nregion=ap-southeast-2','[profile ai-health-wallet]\nsource_profile=default','[profile ai-health-wallet]\ncredential_process=unsafe','[profile ai-health-wallet]\nrole_arn=unsafe','[profile ai-health-wallet]\nregion=a\nregion=b','[profile ai-health-wallet]\n[profile ai-health-wallet]'])assert.throws(()=>selectProfile(text,'profile ai-health-wallet',['region']),VerificationFailure);
 });
 await t.test('successful preflight checks identity, exact owner/bucket and account protections',async()=>{
  const calls:{service:string;operation:string;args:readonly string[]}[]=[];
  const report=await preflight(async(s,o,a)=>{calls.push({service:s,operation:o,args:a});return good(s,o,a);});
  assert.equal(report.passed,true);assert.equal(report.checks.length,7);assert.equal(calls.length,7);
  for(const call of calls.filter(c=>c.service==='s3api'))assert.deepEqual(call.args,['--bucket',target.bucket,'--expected-bucket-owner',target.account]);
  assert.ok(Object.isFrozen(report)&&Object.isFrozen(report.checks));
 });
 await t.test('wrong account or root identity stops before any S3 call',async()=>{
  for(const identity of [{Account:'000000000000',Arn:'synthetic'},{Account:target.account,Arn:`arn:aws:iam::${target.account}:root`}]){
   let calls=0;const report=await preflight(async()=>{calls++;return identity;});assert.equal(report.passed,false);assert.equal(calls,1);
  }
 });
 for(const operation of ['get-caller-identity','get-bucket-location','get-public-access-block','get-bucket-policy-status','get-bucket-ownership-controls','get-bucket-encryption'])await t.test(`${operation} unavailable makes preflight fail without diagnostics`,async()=>{
  const report=await preflight(async(s,o,a)=>{if(o===operation)throw Error('SYNTHETIC_SECRET');return good(s,o,a);});assert.equal(report.passed,false);assert.ok(!JSON.stringify(report).includes('SYNTHETIC_SECRET'));
 });
 await t.test('account-level denial, public policy, disabled flags, wrong owner-mode or encryption all block execution',async()=>{
  for(const bad of ['account','region','policy','flags','ownership','encryption']){
   const report=await preflight(async(s,o,a)=>{
    if(bad==='account'&&s==='s3control')throw Error('denied');
    if(bad==='region'&&o==='get-bucket-location')return {LocationConstraint:'us-east-1'};
    if(bad==='policy'&&o==='get-bucket-policy-status')return {PolicyStatus:{IsPublic:true}};
    if(bad==='flags'&&s==='s3api'&&o==='get-public-access-block')return {};
    if(bad==='ownership'&&o==='get-bucket-ownership-controls')return {OwnershipControls:{Rules:[{ObjectOwnership:'ObjectWriter'}]}};
    if(bad==='encryption'&&o==='get-bucket-encryption')return {ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'aws:kms'}}]}};
    return good(s,o,a);
   });assert.equal(report.passed,false);
  }
 });
 await t.test('no bucket policy is accepted only as a specifically classified response',async()=>{
  assert.equal((await preflight(async(s,o,a)=>o==='get-bucket-policy-status'?{noPolicy:true}:good(s,o,a))).passed,true);
 });
 await t.test('AWS command transport permits only seven read-only operations with exact arguments',async()=>{
  let calls=0;const read=createAwsRead(async a=>{calls++;assert.ok(a.includes('--profile')&&a.includes(target.profile));return '{}';});
  await read('sts','get-caller-identity',[]);
  for(const [s,o,a]of [['s3api','put-object',[]],['s3api','delete-object',[]],['s3','ls',[]],['sts','assume-role',[]],['s3api','get-bucket-policy-status',['--bucket','unrelated']]] as const)await assert.rejects(read(s,o,a),VerificationFailure);
  assert.equal(calls,1);
 });
 await t.test('malformed AWS JSON never becomes a successful check',async()=>{
  assert.equal((await preflight(createAwsRead(async()=>'{invalid SYNTHETIC_SECRET'))).passed,false);
 });
 await t.test('CLI error classification accepts exact no-policy code only on policy-status reads',()=>{
  const message='An error occurred (NoSuchBucketPolicy) when calling the GetBucketPolicyStatus operation (reached max retries: 0): synthetic';
  assert.equal(classifyAwsFailure('s3api','get-bucket-policy-status',message),'NO_POLICY');
  assert.equal(classifyAwsFailure('s3control','get-public-access-block',message),'AWS_READ_FAILED');
  assert.equal(classifyAwsFailure('s3api','get-bucket-policy-status','An error occurred (AccessDenied): synthetic'),'AWS_ACCESS_DENIED');
  assert.equal(classifyAwsFailure('s3control','get-public-access-block','An error occurred (NoSuchPublicAccessBlockConfiguration): synthetic'),'AWS_SECURITY_CONFIGURATION_MISSING');
  assert.equal(classifyAwsFailure('s3api','get-bucket-policy-status','SYNTHETIC_SECRET NoSuchBucketPolicy'),'AWS_READ_FAILED');
 });
 await t.test('preflight options, failed preflight and forged success cannot touch scenario ports',async()=>{
  for(const [options,report]of [[readOnly,await preflight(good)],[live,await preflight(async()=>{throw Error();})],[live,{passed:true,checks:[]}]] as const){
   const p=ports();await assert.rejects(executeScenarios(options,report,p.value),VerificationFailure);assert.deepEqual(p.calls,[]);
  }
 });
 await t.test('three independent registered patients process only their one attached document in order',async()=>{
  const p=ports();await executeScenarios(live,await preflight(good),p.value);
  assert.deepEqual(p.calls,['prepare','register:A','register:B','register:C','upload:A','process:A','verify:A','upload:B','process:B','verify:B','upload:C','process:C','verify:C','preserve','close']);
 });
 for(const stage of ['register','upload','process','verify'] as const)await t.test(`${stage} failure stops without retries and closes resources`,async()=>{
  const p=ports();(p.value[stage] as any)=async()=>{p.calls.push('failed:'+stage);throw new VerificationFailure('EXPECTED');};
  await assert.rejects(executeScenarios(live,await preflight(good),p.value),VerificationFailure);assert.equal(p.calls.filter(c=>c==='failed:'+stage).length,1);assert.deepEqual(p.calls.slice(-2),['preserve','close']);assert.ok(!p.calls.includes('upload:C'));
 });
 await t.test('preservation failure still closes resources',async()=>{
  const p=ports();p.value.preserve=async()=>{throw new VerificationFailure('PRESERVATION');};await assert.rejects(executeScenarios(live,await preflight(good),p.value),VerificationFailure);assert.equal(p.calls.at(-1),'close');
 });
 await t.test('registry rejects absent, copied, foreign, duplicated and unregistered scope',()=>{
  const r=new RunRegistry(),patient=randomUUID();assert.throws(()=>r.attach('A',randomUUID()),VerificationFailure);r.register('A',patient);
  assert.throws(()=>r.register('B',patient),VerificationFailure);assert.throws(()=>r.register('A',randomUUID()),VerificationFailure);
  const scope=r.attach('A',randomUUID());r.assert(scope);assert.throws(()=>r.assert({...scope}),VerificationFailure);assert.throws(()=>r.assert(undefined as any),VerificationFailure);
 });
 await t.test('preservation compares all original hashes, including composite-key rows and duplicates',()=>{
  const before={patients:[{id:'old',hash:'old-hash'}],bridge:[{id:null,hash:'a'},{id:null,hash:'b'},{id:null,hash:'b'}]};
  const after={patients:[...before.patients,{id:'new',hash:'new-hash'}],bridge:[...before.bridge].reverse()};
  assertPreserved(before,after,{patients:new Set(['new'])});
  assert.throws(()=>assertPreserved(before,{...after,bridge:after.bridge.slice(1)},{patients:new Set(['new'])}),VerificationFailure);
  assert.throws(()=>assertPreserved(before,{...after,patients:[{id:'old',hash:'changed'}]},{patients:new Set(['old'])}),VerificationFailure);
  assert.throws(()=>assertPreserved(before,{...after,extra:[]},{patients:new Set(['new'])}),VerificationFailure);
 });
 await t.test('actual repository claim and recovery SQL always carry the registered patient scope',async()=>{
  const registry=new RunRegistry();registry.register('A',randomUUID());const scope=registry.attach('A',randomUUID());const queries:{text:string;values:any[]}[]=[];
  const db={async query(text:string,values:any[]){queries.push({text,values});return {rows:[]};}} as any;
  const config={maxAttempts:3,leaseMs:60000,attemptTimeoutMs:300000,heartbeatMs:15000,retryBaseMs:1000,retryMaxMs:10000,recoveryBatchSize:10};
  const documents={storage:null} as any,retrieval={} as any,storage={bucket:target.bucket,prefix:target.prefix} as any;
  assert.throws(()=>createScenarioWorker(db,config,undefined as any,registry,async()=>{},storage,documents,retrieval),VerificationFailure);assert.equal(queries.length,0);
  const worker=createScenarioWorker(db,config,scope,registry,async()=>{assert.fail('No job should reach processing');},storage,documents,retrieval);
  assert.equal(await worker.runOnce(),'idle');assert.equal(queries.length,2);
  for(const query of queries){assert.equal(query.values[0],scope.patientId);assert.match(query.text,/patient_id=\$1/);assert.ok(query.values.includes(scope.patientId));}
 });
 await t.test('a foreign job returned by a faulty database never reaches the processor',async()=>{
  const registry=new RunRegistry();registry.register('A',randomUUID());const scope=registry.attach('A',randomUUID());
  const db={async query(text:string){return {rows:text.includes('WITH candidate')?[{patient_id:randomUUID(),document_id:randomUUID()}]:[]};}} as any;
  const worker=createScenarioWorker(db,{recoveryBatchSize:1} as any,scope,registry,async()=>assert.fail('Foreign processor'),{} as any,{} as any,{} as any);
  assert.equal(await worker.runOnce(),'unavailable');
 });
 await t.test('storage guards limit uploads to expected bytes and journal before real adapter calls',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'health-wallet-manual-fake-'));
  try{
   const bytes=Buffer.from('Synthetic fixture only'),path=join(directory,'fixture');await writeFile(path,bytes);
   let puts=0,deletes=0,reads=0,saves=0;const uploads:RecordOfUpload[]=[];
   const base:DocumentStorage&OriginalStorage={bucket:target.bucket,prefix:target.prefix,async put(){assert.equal(uploads.length,1);assert.ok(saves>0);puts++;return {versionId:'synthetic-version'};},async remove(){deletes++;},async download(){return 'SYNTHETIC_URL';},async readOriginal(){reads++;return {bytes:bytes.length};}};
   const input={key:target.prefix+randomUUID()+'.pdf',path,bytes:bytes.length,mime:'application/pdf',checksum:createHash('sha256').update(bytes).digest('base64'),signal:new AbortController().signal};
   const guard=createGuardedStorage(base,live,uploads,async()=>{saves++;});await assert.rejects(guard.storage.put(input),VerificationFailure);guard.expect('A',bytes,'application/pdf');await guard.storage.put(input);
   assert.equal(puts,1);assert.equal(uploads[0].confirmed,true);assert.equal(uploads[0].versionId,'synthetic-version');assert.equal(saves,2);
   await assert.rejects(guard.storage.put(input),VerificationFailure);await assert.rejects(guard.storage.remove(input.key),VerificationFailure);await assert.rejects(guard.storage.download(input.key,'synthetic.pdf','pdf',60),VerificationFailure);assert.equal(deletes,0);
   await assert.rejects(guard.storage.readOriginal({key:'foreign',type:'pdf',destination:path,maxBytes:1000,timeoutMs:1000,signal:input.signal}),VerificationFailure);
   await guard.storage.readOriginal({key:input.key,type:'pdf',destination:path,maxBytes:1000,timeoutMs:1000,signal:input.signal});assert.equal(reads,1);
   const readGuard=createGuardedStorage(base,readOnly,[],async()=>{});readGuard.expect('B',bytes,'application/pdf');await assert.rejects(readGuard.storage.put({...input,key:target.prefix+randomUUID()+'.pdf'}),VerificationFailure);assert.equal(puts,1);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 await t.test('hash mismatch and journal failure prevent PUT; ambiguous PUT remains unconfirmed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'health-wallet-manual-failure-'));
  try{
   const bytes=Buffer.from('synthetic'),path=join(directory,'fixture');await writeFile(path,bytes);let calls=0;
   const base={bucket:target.bucket,prefix:target.prefix,async put(){calls++;throw Error('SYNTHETIC_SECRET');}} as any;
   const input={key:target.prefix+randomUUID()+'.pdf',path,bytes:bytes.length,mime:'application/pdf',checksum:createHash('sha256').update(bytes).digest('base64'),signal:new AbortController().signal};
   const mismatch=createGuardedStorage(base,live,[],async()=>{});mismatch.expect('A',bytes,'application/pdf');await assert.rejects(mismatch.storage.put({...input,checksum:'wrong'}),VerificationFailure);assert.equal(calls,0);
   const journal=createGuardedStorage(base,live,[],async()=>{throw new VerificationFailure('JOURNAL');});journal.expect('A',bytes,'application/pdf');await assert.rejects(journal.storage.put(input),VerificationFailure);assert.equal(calls,0);
   const uploads:RecordOfUpload[]=[];const ambiguous=createGuardedStorage(base,live,uploads,async()=>{});ambiguous.expect('A',bytes,'application/pdf');await assert.rejects(ambiguous.storage.put(input));assert.equal(calls,1);assert.equal(uploads[0].confirmed,false);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 await t.test('production upload compensation calls are blocked only by runner adapter, with zero real deletes',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'health-wallet-manual-compensation-'));
  try{
   const bytes=Buffer.from('synthetic'),path=join(directory,'fixture');await writeFile(path,bytes);let deletes=0;
   const base={bucket:target.bucket,prefix:target.prefix,async put(){return {};},async remove(){deletes++;}} as any;
   const guard=createGuardedStorage(base,live,[],async()=>{});guard.expect('A',bytes,'application/pdf');
   const repository={async insert(){throw Error('synthetic');},async reference(){return undefined;}} as unknown as ReturnType<typeof createDocumentRepository>;
   const previous=console.error;console.error=()=>{};
   try{await assert.rejects(createDocumentService(repository,guard.storage).upload({path,bytes:bytes.length,mime:'application/pdf',checksum:createHash('sha256').update(bytes).digest('base64'),type:'pdf',name:'synthetic.pdf',metadata:{hospital_name:'Synthetic',category:'lab_report'},async dispose(){}},randomUUID(),new AbortController().signal));}
   finally{console.error=previous;}assert.equal(deletes,0);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
 await t.test('importing CLI and live implementation causes no execution or connection',async()=>{
  const cli=await import('../integration/cli.js'),liveModule=await import('../integration/live-run.js');assert.equal(typeof cli.main,'function');assert.equal(typeof liveModule.runLiveScenarios,'function');
  await assert.rejects(liveModule.runLiveScenarios(readOnly,await preflight(good),{accessKeyId:'synthetic',secretAccessKey:'synthetic'}),VerificationFailure);
 });
});
