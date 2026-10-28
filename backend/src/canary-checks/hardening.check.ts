import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseLive,assertRuntimeApproval} from '../stage-c/runtime-flags.js';
import {main} from '../stage-c/cli.js';
import {verifySupervisionProof,digest,type SupervisionProof} from '../stage-c/proof.js';
import {validateInside,type InsideProtection} from '../stage-c/inside-protection.js';
import {validateManifest,type CanaryManifest} from '../stage-c/live-composition.js';
import {target} from '../stage-c/safety.js';
import {stopOwned,transientArguments,type UnitPlan} from '../stage-c/supervision.js';
import {microseconds,parseProperties} from '../stage-c/systemd-adapter.js';
import {syntheticApi} from '../stage-c/adapters.js';
const run='stage-c-'+'d'.repeat(24),patient='00000000-0000-4000-8000-000000000001',control='00000000-0000-4000-8000-000000000002';
const seed=['--seed','--approve-live-writes','--approve-synthetic-seeding',...['profile','account','bucket','region'].flatMap(k=>['--'+k,target[k as keyof typeof target]]),'--run-id',run,'--evidence-dir','/private/evidence','--supervision-receipt','/private/proof.json','--supervision-sha256','a'.repeat(64)];
for(const flag of ['--approve-live-writes','--approve-synthetic-seeding','--profile','--account','--bucket','--region','--run-id','--evidence-dir','--supervision-receipt','--supervision-sha256'])test('live factory unavailable without '+flag,async()=>{
 const args=[...seed],i=args.indexOf(flag);args.splice(i,flag.startsWith('--approve')?1:2);let called=false;assert.equal(await main(args,()=>{},async()=>{called=true;}),1);assert.equal(called,false);
});
test('seed and activation approvals cannot substitute for each other',()=>{assert.throws(()=>parseLive(seed.map(v=>v==='--approve-synthetic-seeding'?'--approve-service-activation':v)));assert.throws(()=>parseLive(seed.map(v=>v==='--seed'?'--activate':v)));});
test('correct flags dispatch a seed only to an injected fake',async()=>{let phase='';assert.equal(await main(seed,()=>{},async o=>{phase=o.phase;}),0);assert.equal(phase,'seed');});
test('duplicate approvals and default AWS profile are refused',()=>{assert.throws(()=>parseLive([...seed,'--approve-live-writes']));assert.throws(()=>parseLive(seed.map(v=>v===target.profile?'default':v)));});
test('missing activation scope or approval file refuses dispatch',()=>{const args=seed.map(v=>v==='--seed'?'--activate':v==='--approve-synthetic-seeding'?'--approve-service-activation':v);assert.throws(()=>parseLive(args));});
const identity={bootId:'synthetic-boot',nodeSha256:'a'.repeat(64),insideSha256:'b'.repeat(64),supervisionSha256:'c'.repeat(64)};
const proof=():SupervisionProof=>({version:2,passed:true,createdAt:new Date().toISOString(),...identity,checks:['inside-protection','effective-limits','native-containment','graceful-cleanup','controller-loss-cleanup'].map(check=>({check,passed:true}))});
async function proofFile(change:(p:SupervisionProof)=>void=()=>{}){const dir=await mkdtemp(join(tmpdir(),'stage-c-proof-test-'));await chmod(dir,0o700);const p=proof();change(p);const bytes=Buffer.from(JSON.stringify(p));const path=dir+'/report.json';await writeFile(path,bytes,{mode:0o600});return {dir,path,pin:digest(bytes),close:()=>rm(dir,{recursive:true,force:true})};}
test('fresh private proof binds host boot, artifacts and all containment stages',async()=>{const f=await proofFile();try{await verifySupervisionProof(f.path,f.pin,identity);}finally{await f.close();}});
for(const [name,mutate]of Object.entries({failed:(p:SupervisionProof)=>{p.passed=false;},stale:(p:SupervisionProof)=>{p.createdAt='2000-01-01T00:00:00.000Z';},reboot:(p:SupervisionProof)=>{p.bootId='other';},artifact:(p:SupervisionProof)=>{p.insideSha256='e'.repeat(64);},missing:(p:SupervisionProof)=>{p.checks.pop();},duplicated:(p:SupervisionProof)=>{p.checks[4]=p.checks[0];}}))test('refuses '+name+' supervision proof',async()=>{const f=await proofFile(mutate);try{await assert.rejects(verifySupervisionProof(f.path,f.pin,identity));}finally{await f.close();}});
test('proof checksum and permissions are mandatory',async()=>{const f=await proofFile();try{await assert.rejects(verifySupervisionProof(f.path,'0'.repeat(64),identity));await chmod(f.path,0o644);await assert.rejects(verifySupervisionProof(f.path,f.pin,identity));}finally{await f.close();}});
const group='/user.slice/user-1000.slice/user@1000.service/app.slice/test.service';
function inside():InsideProtection{const parent=group.slice(0,group.lastIndexOf('/'));return {version:1,pid:123,uid:process.getuid!(),cgroup:group,mountNamespace:'mnt:[1]',userNamespace:'user:[1]',protected:true,interfaces:[group+'/cgroup.procs',group+'/cgroup.threads',group+'/cpu.max',group+'/memory.max',group+'/pids.max',parent+'/cgroup.procs','/cgroup.procs'].map(path=>({path,readOnly:true,writable:false,openDenied:true}))};}
test('inside proof requires kernel-denied opens AND read-only paths',()=>{validateInside(inside(),group);const a=inside();a.interfaces[0].openDenied=false;assert.throws(()=>validateInside(a,group));const b=inside();b.interfaces[0].readOnly=false;assert.throws(()=>validateInside(b,group));});
test('duplicate or foreign cgroup interface attestations cannot pass',()=>{const a=inside();a.interfaces[1]=a.interfaces[0];assert.throws(()=>validateInside(a,group));assert.throws(()=>validateInside(inside(),'/other'));});
test('effective property parser is closed to sensitive fields',()=>{assert.deepEqual(parseProperties('Restart=no\nPrivateUsers=yes'),{Restart:'no',PrivateUsers:'yes'});assert.throws(()=>parseProperties('Environment=private'));assert.equal(microseconds('10min'),600000000);assert.equal(microseconds('500ms'),500000);assert.throws(()=>microseconds('infinity'));});
test('transient launch requests user namespace and pre-start enforcement',()=>{const p:UnitPlan={run,uid:1000,node:'/usr/bin/node',entry:'/project/backend/dist/processing/background-entry.js',workingDirectory:'/project/backend',environmentFile:'/private/worker.env',controllerUnit:'health-wallet-'+run+'-controller.service',insideReport:'/private/inside.json'};const args=transientArguments(p);assert.ok(args.includes('PrivateUsers=yes'));assert.ok(args.some(v=>v.startsWith('ExecStartPre=')&&v.includes('inside-entry.js')));assert.ok(args.includes('Restart=no'));});
test('new synthetic credential persistence occurs before an ambiguous registration',async()=>{const events:string[]=[];const api=syntheticApi('http://127.0.0.1:1234',run,(async()=>{events.push('http');throw Error('ambiguous');}) as typeof fetch,async()=>{events.push('credential-intent');});const s=new AbortController().signal;await assert.rejects(api.register('canary',s));await assert.rejects(api.register('canary',s));assert.deepEqual(events,['credential-intent','http']);});
test('re-login verifies authenticated identity and denies control uploads',async()=>{
 const calls:string[]=[];const api=syntheticApi('http://127.0.0.1:1234',run,(async(url)=>{calls.push(String(url));return new Response(JSON.stringify(String(url).endsWith('/login')?{access_token:'synthetic-token'}:{patient:{id:control}}),{status:200});}) as typeof fetch);
 await api.login('control',control,{email:run+'-control@example.invalid',password:'a'.repeat(43)},new AbortController().signal);
 await assert.rejects(api.upload('mixed',control,Buffer.from('%PDF'),new AbortController().signal));assert.equal(calls.length,2);api.close();
});
test('re-login refuses another authenticated patient',async()=>{
 const api=syntheticApi('http://127.0.0.1:1234',run,(async(url)=>new Response(JSON.stringify(String(url).endsWith('/login')?{access_token:'synthetic-token'}:{patient:{id:control}}),{status:200})) as typeof fetch);
 await assert.rejects(api.login('canary',patient,{email:run+'-canary@example.invalid',password:'a'.repeat(43)},new AbortController().signal));api.close();
});
test('activation requires seeded exact-target receipts, not guessed scopes',()=>{const o=parseLive(seed);const m:CanaryManifest={version:2,run,target,stage:'seeding',patients:[],documents:[],uploads:[],fixtures:{sentinel:'a'.repeat(64),mixed:'b'.repeat(64)},events:[]};validateManifest(o,m);assert.throws(()=>validateManifest({...o,run:'stage-c-'+'e'.repeat(24)},m));assert.throws(()=>validateManifest({...o,phase:'activate'},m));});
test('CLI redacts injected adapter exceptions',async()=>{const lines:string[]=[];assert.equal(await main(seed,line=>lines.push(line),async()=>{throw Error('private-password medical-documents/private');}),1);assert.ok(!lines.join('').includes('private-password')&&!lines.join('').includes('medical-documents/'));});
test('live runtime imports neither OCR processor nor a direct worker',async()=>{const text=await readFile(new URL('../stage-c/live-runtime.ts',import.meta.url),'utf8');assert.ok(!/runOnce\s*\(|createProcessingWorker|createOcrProcessor|composeBackground/.test(text));assert.ok(text.includes('maxAttempts:1'));});

test('serialized approval options do not grant runtime capability',()=>{const o=parseLive(seed);assertRuntimeApproval(o);assert.throws(()=>assertRuntimeApproval(JSON.parse(JSON.stringify(o))));});
test('owned unit is stopped even when effective protection is unsafe',async()=>{
 const p:UnitPlan={run,uid:1000,node:'/usr/bin/node',entry:'/project/backend/dist/processing/background-entry.js',workingDirectory:'/project/backend',environmentFile:'/private/worker.env',controllerUnit:'health-wallet-'+run+'-controller.service'};
 let stopped=false;const status={id:'health-wallet-'+run+'.service',description:'AI Health Wallet '+run,uid:1000,transient:true,fragmentPath:'/run/user/1000/systemd/transient/health-wallet-'+run+'.service',execStart:[p.node,p.entry],controlGroup:'/user.slice/user-1000.slice/user@1000.service/app.slice/health-wallet-'+run+'.service'} as unknown as import('../stage-c/supervision.js').UnitStatus;
 await assert.rejects(stopOwned(p,{inspect:async()=>status,start:async()=>{},stop:async()=>{stopped=true;}}));assert.equal(stopped,true);
});


test('worker detection includes relative compiled and tsx entry paths',async()=>{
 const {isBackgroundCommand}=await import('../stage-c/runtime-policies.js');
 for(const args of ['node\0dist/processing/background-entry.js\0','node\0/project/backend/dist/processing/background-entry.js\0','tsx\0src/processing/background-entry.ts\0'])assert.equal(isBackgroundCommand(args),true);
 assert.equal(isBackgroundCommand('node\0dist/server.js\0'),false);
});
test('private launch serializer preserves literal quotes, slashes and dollar signs',async()=>{
 const {serializeEnvironment}=await import('../stage-c/runtime-policies.js');const value=serializeEnvironment({SYNTHETIC_CHECK:'literal $ % " \\'});
 assert.ok(value.includes('$')&&value.includes('%')&&value.includes('\\"')&&value.includes('\\\\'));
});
test('private launch serializer refuses line and key injection',async()=>{
 const {serializeEnvironment}=await import('../stage-c/runtime-policies.js');assert.throws(()=>serializeEnvironment({CHECK:'a\nOTHER=b'}));assert.throws(()=>serializeEnvironment({'BAD=KEY':'value'}));
});
