import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,readFile,stat,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parsePreparation,checkPreparation,checkReceipt,freshPreflight,target,type Preparation,type UploadReceipt} from '../stage-c/safety.js';
import {renderUnit,checkUnit,stopOwned,type UnitPlan,type UnitStatus} from '../stage-c/supervision.js';
import {executeCanary,seedCanary,type CanaryPorts} from '../stage-c/controller.js';
import {openJournal,checkIgnored} from '../stage-c/evidence.js';
import {main} from '../stage-c/cli.js';
import {syntheticApi,canaryStorage} from '../stage-c/adapters.js';
import type {AwsRead,RecordOfUpload} from '../integration/guards.js';
const patient='00000000-0000-4000-8000-000000000001',control='00000000-0000-4000-8000-000000000002';
const doc='00000000-0000-4000-8000-000000000003',mixed='00000000-0000-4000-8000-000000000004';
const run='stage-c-'+'a'.repeat(24),sha='b'.repeat(64),cutoff='2026-10-21T12:00:00.000Z';
const checks:AwsRead=async(_s,operation)=>{
 switch(operation){
 case 'get-caller-identity':return {Account:target.account,Arn:'arn:aws:iam::'+target.account+':user/synthetic'};
 case 'get-bucket-location':return {LocationConstraint:target.region};
 case 'get-public-access-block':return {PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}};
 case 'get-bucket-policy-status':return {PolicyStatus:{IsPublic:false}};
 case 'get-bucket-ownership-controls':return {OwnershipControls:{Rules:[{ObjectOwnership:'BucketOwnerEnforced'}]}};
 case 'get-bucket-encryption':return {ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]}};
 default:throw Error('Unexpected fake operation');
 }
};
const plan:UnitPlan={run,uid:1000,node:'/usr/bin/node',entry:'/project/backend/dist/processing/background-entry.js',workingDirectory:'/project/backend',environmentFile:'/private/launch.env',controllerUnit:'health-wallet-'+run+'-controller.service'};
function status(active=true):UnitStatus{return {id:'health-wallet-'+run+'.service',description:'AI Health Wallet '+run,uid:1000,transient:true,
 fragmentPath:'/run/user/1000/systemd/transient/health-wallet-'+run+'.service',restart:'no',type:'exec',execStart:[plan.node,plan.entry],bindsTo:[plan.controllerUnit],after:[plan.controllerUnit],
 cpuQuotaPerSecUSec:2000000,memoryMax:3221225472,tasksMax:128,runtimeMaxUSec:600000000,timeoutStopUSec:60000000,killMode:'mixed',killSignal:'SIGTERM',sendSIGKILL:true,
 noNewPrivileges:true,protectControlGroups:true,delegate:false,umask:'0077',active,mainPid:active?123:0,
 controlGroup:'/user.slice/user-1000.slice/user@1000.service/app.slice/health-wallet-'+run+'.service',populated:active,pids:active?[123,124]:[],
 effective:{cpuQuota:200000,cpuPeriod:100000,memoryMax:3221225472,pidsMax:128,readOnlyCgroupMount:true}};}
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'health-wallet-stage-c-fake-'));await chmod(dir,0o700);
 const bytes=Buffer.from(JSON.stringify({version:1,mode:'canary',patientId:patient,uploadCutoff:cutoff,...Object.fromEntries(['profile','account','bucket','region'].map(k=>[k,target[k as keyof typeof target]]))}));
 await writeFile(dir+'/approval.json',bytes,{mode:0o600});
 const args=['--check',...['profile','account','bucket','region'].flatMap(k=>['--'+k,target[k as keyof typeof target]]), '--run-id',run,'--patient',patient,'--control-patient',control,'--cutoff',cutoff,'--approval-file',dir+'/approval.json','--approval-sha256',createHash('sha256').update(bytes).digest('hex')];
 return {dir,args,p:parsePreparation(args),close:()=>rm(dir,{recursive:true,force:true})};
}
const receipt=(role:'sentinel'|'mixed',completed=false):UploadReceipt=>({run,role,patientId:patient,documentId:role==='sentinel'?doc:mixed,key:target.prefix+(role==='sentinel'?doc:mixed)+'.pdf',fixtureSha256:sha,originalSha256:sha,bytes:100,
 confirmed:true,observedAt:new Date().toISOString(),jobCount:1,state:role==='sentinel'?'pending':completed?'completed':'running',attempt:role==='sentinel'?0:1,extractions:completed?1:0,
 methods:completed?['pdf_text','ocr']:[],pages:completed?[1,2]:[],evidenceAttempt:completed?1:undefined,currentAttempt:completed,atomicCompletion:completed,originalUnchanged:true,privateObject:true});
function ports(events:string[]=[]):CanaryPorts{
 let active=false;return {readAws:checks,signal:new AbortController().signal,now:()=>Date.now(),prepared:async()=>({sentinel:receipt('sentinel'),sentinelSha:sha,mixedSha:sha}),
 checkDatabase:async()=>{events.push('database');},noOtherService:async()=>{guardNo(active);},journal:async e=>{events.push(e);},
 supervisor:{inspect:async()=>status(active),start:async()=>{active=true;events.push('start');},stop:async()=>{active=false;events.push('stop');}},
 ready:async()=>{events.push('ready');},uploadMixed:async()=>{events.push('upload');return receipt('mixed');},observe:async id=>receipt(id===doc?'sentinel':'mixed',id!==doc),
 crossPatientDenied:async()=>{events.push('denied');},verifyPreservation:async()=>{events.push('preserved');},idleAndUnchanged:async()=>{events.push('idle');},
 verifyTemporaryCleanup:async()=>{events.push('temp-clean');},verifyCoordinatorReleased:async()=>{events.push('unlocked');},preserve:async()=>{events.push('evidence');}};
}
function guardNo(v:boolean){assert.equal(v,false);}
for(const key of ['profile','account','bucket','region','patient','control-patient','cutoff','approval-file','approval-sha256','run-id'])test('refuses missing '+key,async()=>{
 const f=await fixture();try{const args=[...f.args],i=args.indexOf('--'+key);args.splice(i,2);assert.throws(()=>parsePreparation(args));}finally{await f.close();}
});
for(const key of ['profile','account','bucket','region'])test('refuses incorrect '+key,async()=>{
 const f=await fixture();try{const args=[...f.args];args[args.indexOf('--'+key)+1]='default';assert.throws(()=>parsePreparation(args));}finally{await f.close();}
});
test('CLI refuses live activation flags before touching dependencies',async()=>{const lines:string[]=[];assert.equal(await main(['--run','--approve-live-writes'],l=>lines.push(l)),1);assert.deepEqual(JSON.parse(lines[0]),{service:'stage-c-controller',phase:'stopped',passed:false});});
test('private approval valid across simulated restarts',async()=>{const f=await fixture();try{await checkPreparation(f.p);await checkPreparation(parsePreparation(f.args));assert.equal(await main(f.args,()=>{}),0);}finally{await f.close();}});
for(const mode of [0o644,0o400])test('refuses approval permissions '+mode,async()=>{const f=await fixture();try{await chmod(f.dir+'/approval.json',mode);await assert.rejects(checkPreparation(f.p));}finally{await f.close();}});
test('refuses changed cutoff and approval checksum',async()=>{const f=await fixture();try{await writeFile(f.dir+'/approval.json','{}');await assert.rejects(checkPreparation(f.p));}finally{await f.close();}});
test('refuses symlink approval',async()=>{const f=await fixture();try{await symlink(f.dir+'/approval.json',f.dir+'/link.json');const p={...f.p,config:{...f.p.config,approvalPath:f.dir+'/link.json'}};await assert.rejects(checkPreparation(p));}finally{await f.close();}});
test('fresh preflight performs all seven checks and refuses any failure',async()=>{let count=0;await freshPreflight(async(...a)=>{count++;return checks(...a);});assert.equal(count,7);await assert.rejects(freshPreflight(async()=>{throw Error('sensitive token');}));});
test('configuration is one instance, no restart, bounded and cgroup contained',()=>{const unit=renderUnit(plan);for(const line of ['Restart=no','KillMode=mixed','CPUQuota=200%','MemoryMax=3221225472','TasksMax=128','RuntimeMaxSec=600','ProtectControlGroups=yes','Delegate=no'])assert.ok(unit.includes(line));assert.ok(!unit.includes('[Install]'));checkUnit(plan,status(),true);});
for(const [key,value]of Object.entries({uid:1001,transient:false,fragmentPath:'/etc/systemd/system/other.service',description:'unowned',restart:'always',memoryMax:999,tasksMax:999,runtimeMaxUSec:999,cpuQuotaPerSecUSec:999,delegate:true,protectControlGroups:false,killMode:'process'}))test('refuses incorrect unit '+key,()=>assert.throws(()=>checkUnit(plan,{...status(),[key]:value},true)));
test('refuses ineffective cgroup controls',()=>assert.throws(()=>checkUnit(plan,{...status(),effective:{...status().effective,pidsMax:999}},true)));
test('refuses environment path injection',()=>assert.throws(()=>renderUnit({...plan,environmentFile:'/tmp/a\nRestart=always'})));
test('does not stop an unowned unit',async()=>{let stopped=false;await assert.rejects(stopOwned(plan,{inspect:async()=>({...status(),uid:1}),stop:async()=>{stopped=true;},start:async()=>{}}));assert.equal(stopped,false);});
test('unexpected subprocess survival is fatal',async()=>{let n=0;await assert.rejects(stopOwned(plan,{inspect:async()=>n++===0?status():({...status(false),pids:[124],populated:true}),stop:async()=>{},start:async()=>{}}));});
test('successful sequence starts only supervisor and keeps same approval on idle restart',async()=>{const f=await fixture(),events:string[]=[];try{await executeCanary(f.p,plan,ports(events),'activate-synthetic-canary');assert.equal(events.filter(e=>e==='upload').length,1);assert.equal(events.filter(e=>e==='start').length,2);assert.equal(events.filter(e=>e==='stop').length,2);assert.ok(events.indexOf('ready')<events.indexOf('upload'));assert.equal(events.at(-1),'evidence');}finally{await f.close();}});
for(const failure of ['ready','uploadMixed','observe','verifyPreservation','checkDatabase'] as const)test('failure stops sequence without upload retry: '+failure,async()=>{const f=await fixture(),events:string[]=[];try{const p=ports(events);p[failure]=async()=>{throw Error('protected values');};await assert.rejects(executeCanary(f.p,plan,p,'activate-synthetic-canary'));assert.ok(events.filter(e=>e==='upload').length<=1);assert.equal(events.at(-1),'evidence');if(events.includes('start'))assert.ok(events.includes('stop'));}finally{await f.close();}});
test('preflight failure never starts unit or uploads',async()=>{const f=await fixture(),events:string[]=[];try{const p=ports(events);p.readAws=async()=>({});await assert.rejects(executeCanary(f.p,plan,p,'activate-synthetic-canary'));assert.ok(!events.includes('start')&&!events.includes('upload'));}finally{await f.close();}});
test('cancellation after startup stops owned unit',async()=>{const f=await fixture(),events:string[]=[],cancel=new AbortController();try{const p=ports(events);p.signal=cancel.signal;p.ready=async()=>{cancel.abort();};await assert.rejects(executeCanary(f.p,plan,p,'activate-synthetic-canary'));assert.ok(events.includes('stop'));assert.ok(!events.includes('upload'));}finally{await f.close();}});
test('changed approval prevents restart',async()=>{const f=await fixture(),events:string[]=[];try{const p=ports(events);p.idleAndUnchanged=async()=>{await writeFile(f.dir+'/approval.json','{}');};await assert.rejects(executeCanary(f.p,plan,p,'activate-synthetic-canary'));assert.equal(events.filter(e=>e==='start').length,1);}finally{await f.close();}});
for(const mutate of [(r:UploadReceipt)=>{r.run='stale';},(r:UploadReceipt)=>{r.confirmed=false;},(r:UploadReceipt)=>{r.observedAt='2000-01-01T00:00:00Z';},(r:UploadReceipt)=>{r.originalSha256='c'.repeat(64);},(r:UploadReceipt)=>{r.patientId=control;},(r:UploadReceipt)=>{r.pages=[2,1];},(r:UploadReceipt)=>{r.evidenceAttempt=2;},(r:UploadReceipt)=>{r.jobCount=2;}])test('rejects invalid database/S3 receipt '+mutate.toString().split('{')[1],async()=>{const f=await fixture();try{const r=receipt('mixed',true);mutate(r);assert.throws(()=>checkReceipt(f.p,r,'mixed',sha,Date.now(),true));}finally{await f.close();}});
test('historical sentinel cannot be reported processed',async()=>{const f=await fixture();try{const r=receipt('sentinel');r.state='completed';assert.throws(()=>checkReceipt(f.p,r,'sentinel',sha,Date.now()));}finally{await f.close();}});
test('seed journals intents and stops at cutoff without service activation',async()=>{const events:string[]=[];const result=await seedCanary(run,{readAws:checks,signal:new AbortController().signal,preserveBaseline:async()=>{},journal:async e=>{events.push(e);},register:async role=>role==='canary'?patient:control,uploadSentinel:async()=>receipt('sentinel'),proposeCutoff:async()=>cutoff,preserve:async()=>{events.push('evidence');}},'initial-synthetic-writes');assert.equal(result.patients.length,2);assert.equal(events.filter(e=>e==='registration-intent').length,2);assert.equal(events.at(-1),'evidence');});
test('private journal is durable, checksum checked, and never guesses missing receipts',async()=>{const f=await fixture();try{const j=await openJournal('/fake',f.dir,async()=>{});await assert.rejects(j.read('receipts'));await j.save('manifest',{synthetic:true});const bytes=await readFile(f.dir+'/manifest.json');assert.deepEqual(await j.read('manifest',createHash('sha256').update(bytes).digest('hex')),{synthetic:true});assert.equal((await stat(f.dir+'/manifest.json')).mode&0o777,0o600);await assert.rejects(j.read('manifest','0'.repeat(64)));}finally{await f.close();}});
test('Git exclusion failure prevents evidence writes',async()=>{const f=await fixture();try{await assert.rejects(openJournal('/fake',f.dir,async()=>{throw Error('tracked');}));}finally{await f.close();}});
test('Git check refuses outside private evidence',async()=>{await assert.rejects(checkIgnored(process.cwd(),process.cwd()+'/src/public.json'));});
test('source is disconnected from API and contains no worker calls',async()=>{const controller=await readFile(new URL('../stage-c/controller.ts',import.meta.url),'utf8');assert.ok(!/runOnce\s*\(|composeBackground|background-runtime/.test(controller));for(const file of ['../app.ts','../server.ts'])assert.ok(!(await readFile(new URL(file,import.meta.url),'utf8')).includes('stage-c'));});
test('API adapter rejects remote endpoints and never retries ambiguous registration',async()=>{assert.throws(()=>syntheticApi('https://example.invalid',run,fetch));let calls=0;const api=syntheticApi('http://127.0.0.1:1234',run,(async()=>{calls++;throw Error('JWT private');}) as typeof fetch);const signal=new AbortController().signal;await assert.rejects(api.register('canary',signal));await assert.rejects(api.register('canary',signal));assert.equal(calls,1);api.close();});
test('runner storage blocks compensation deletion and signing',async()=>{let touched=false;const uploads:RecordOfUpload[]=[];const a=canaryStorage({bucket:target.bucket,prefix:target.prefix,put:async()=>({}),remove:async()=>{touched=true;},download:async()=>{touched=true;return '';},readOriginal:async()=>{throw Error();}},uploads,async()=>{});await assert.rejects(a.storage.remove({key:'synthetic'} as never));await assert.rejects(a.storage.download('synthetic','synthetic.pdf','pdf',60));assert.equal(touched,false);});
test('redacted CLI error cannot disclose exception values',async()=>{const lines:string[]=[];await main(['--check','JWT-private','medical-documents/private'],l=>lines.push(l));assert.ok(!JSON.stringify(lines).includes('JWT-private')&&!JSON.stringify(lines).includes('medical-documents/'));});
