// Explicit offline probe; the only supervised programs are new synthetic fixtures.
import {mkdtemp,mkdir,writeFile,readFile,chmod,lstat} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {guard} from '../processing/background-config.js';
import {transientArguments,unitName,type UnitPlan} from '../stage-c/supervision.js';
import {localCommand,microseconds} from '../stage-c/systemd-adapter.js';
import {serializeEnvironment} from '../stage-c/runtime-policies.js';
import {localProofIdentity,type SupervisionProof} from '../stage-c/proof.js';
import type {InsideProtection} from '../stage-c/inside-protection.js';
guard(process.argv.slice(2).join(' ')==='--offline-supervision-probe');
const root=await mkdtemp(tmpdir()+'/health-wallet-stage-c-hardening-os-');await chmod(root,0o700);
const run='stage-c-'+randomBytes(12).toString('hex'),uid=process.getuid!(),controller='health-wallet-'+run+'-controller.service';
const plan:UnitPlan={run,uid,node:process.execPath,entry:root+'/dist/processing/background-entry.js',workingDirectory:root,environmentFile:root+'/empty.env',controllerUnit:controller};
await mkdir(root+'/dist/processing',{recursive:true,mode:0o700});await writeFile(root+'/package.json','{"type":"module"}',{mode:0o600});
const syntheticEnvironmentValue='synthetic $ % \" \\\\ literal';
await writeFile(root+'/empty.env',serializeEnvironment({PROCESSING_SERVICE_ENABLED:'false',SYNTHETIC_ENV_PROBE:syntheticEnvironmentValue}),{mode:0o600});await writeFile(root+'/controller.cjs','setInterval(()=>{},1000);',{mode:0o600});
const compiled=fileURLToPath(new URL('../../dist/stage-c/inside-protection.js',import.meta.url));
await writeFile(plan.entry,`import {inspectInside} from ${JSON.stringify(pathToFileURL(compiled).href)};
import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
if(process.env.SYNTHETIC_ENV_PROBE!==${JSON.stringify(syntheticEnvironmentValue)})throw Error('Synthetic environment parsing failed');
const report=await inspectInside();const child=spawn('/usr/bin/sleep',['120'],{stdio:'ignore',detached:true});
writeFileSync(${JSON.stringify(root+'/inside.json')},JSON.stringify({report,child:child.pid}),{mode:0o600});
process.on('SIGTERM',()=>{child.kill('SIGKILL');child.once('close',()=>process.exit(0));});setInterval(()=>{},1000);`,{mode:0o600});
const owned=new Set<string>(),checks=new Map<string,boolean>();let rootCause='unknown',baseline:InsideProtection|undefined;
const property=(unit:string,key:string)=>localCommand('systemctl',['--user','show',unit,'--property='+key,'--value']);
async function owner(unit:string){guard(owned.has(unit));guard(await property(unit,'Transient')==='yes'&&await property(unit,'Description')==='AI Health Wallet '+run);}
async function waitFor(check:()=>Promise<boolean>,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('Probe deadline');}
async function cleanup(unit:string){
 const load=await property(unit,'LoadState');if(load==='not-found')return;await owner(unit);
 const group=await property(unit,'ControlGroup');let child='';try{child=String(JSON.parse(await readFile(root+'/inside.json','utf8')).child??'');}catch{}
 await localCommand('systemctl',['--user','stop',unit],70000);
 if(unit===unitName(run)&&group){await waitFor(async()=>{try{return (await readFile('/sys/fs/cgroup'+group+'/cgroup.events','utf8')).includes('populated 0');}catch(e){return (e as NodeJS.ErrnoException).code==='ENOENT';}});
  if(/^\d+$/.test(child)){try{process.kill(Number(child),0);throw Error('Child survived');}catch(e){guard((e as NodeJS.ErrnoException).code==='ESRCH');}}
 }
}
async function launch(privateUsers:boolean){
 await writeFile(root+'/inside.json','',{mode:0o600});const args=transientArguments(plan);
 const i=args.indexOf('PrivateUsers=yes');guard(i>0);if(!privateUsers){args[i]='PrivateUsers=no';for(const value of ['PrivateMounts=yes','ReadOnlyPaths=/sys/fs/cgroup']){const n=args.indexOf(value);guard(n>0);args.splice(n-1,2);}}
 owned.add(unitName(run));await localCommand('systemd-run',args);await owner(unitName(run));
 await waitFor(async()=>{try{return !!(await readFile(root+'/inside.json','utf8'));}catch{return false;}});
 const data=JSON.parse(await readFile(root+'/inside.json','utf8')) as {report:InsideProtection;child:number};
 const group='/user.slice/user-'+uid+'.slice/user@'+uid+'.service/app.slice/'+unitName(run);
 guard(data.report.cgroup===group&&await property(unitName(run),'ControlGroup')===group&&String(data.report.pid)===await property(unitName(run),'MainPID'));
 guard((await readFile('/proc/'+data.child+'/cgroup','utf8')).trim()==='0::'+group);
 const [q,p]=(await readFile('/sys/fs/cgroup'+group+'/cpu.max','utf8')).trim().split(' ').map(Number);guard(q===2*p);
 guard((await readFile('/sys/fs/cgroup'+group+'/memory.max','utf8')).trim()==='3221225472'&&(await readFile('/sys/fs/cgroup'+group+'/pids.max','utf8')).trim()==='128');
 guard(microseconds(await property(unitName(run),'RuntimeMaxUSec'))===600000000&&microseconds(await property(unitName(run),'TimeoutStopUSec'))===60000000);
 for(const [key,value]of Object.entries({ProtectControlGroups:'yes',PrivateUsers:privateUsers?'yes':'no',Delegate:'no',NoNewPrivileges:'yes',KillMode:'mixed',Restart:'no'}))guard(await property(unitName(run),key)===value);
 return data;
}
try{
 owned.add(controller);await localCommand('systemd-run',['--user','--unit='+controller,'--property','Description=AI Health Wallet '+run,'--property','Restart=no','--property','RuntimeMaxSec=180','--property','MemoryMax=64M','--property','TasksMax=16','--property','CPUQuota=50%','--property','StandardOutput=null','--property','StandardError=null','--',process.execPath,root+'/controller.cjs']);
 baseline=(await launch(false)).report;await writeFile(root+'/baseline-inside.json',JSON.stringify(baseline)+'\n',{mode:0o600});await cleanup(unitName(run));
 const hardened=await launch(true);await writeFile(root+'/hardened-inside.json',JSON.stringify(hardened.report)+'\n',{mode:0o600});
 checks.set('inside-protection',hardened.report.protected);checks.set('native-containment',true);checks.set('effective-limits',true);guard(hardened.report.protected);
 await cleanup(unitName(run));checks.set('graceful-cleanup',true);
 await launch(true);await owner(controller);await localCommand('systemctl',['--user','kill','--kill-whom=main','--signal=SIGKILL',controller]);
 await cleanup(unitName(run));checks.set('controller-loss-cleanup',true);rootCause='explicit-read-only-path-enforces-cgroup-protection';
}catch{
 process.exitCode=1;rootCause=baseline&&!baseline.protected?'user-filesystem-namespace-not-enforced':'probe-failed';
 const details:Record<string,string>={};for(const key of ['Result','ExecMainStatus','PrivateUsers','ProtectControlGroups','ActiveState'])try{details[key]=await property(unitName(run),key);}catch{}
 if(details.PrivateUsers==='yes'&&details.ExecMainStatus==='217')rootCause='private-user-namespace-refused';
 await writeFile(root+'/failure-properties.json',JSON.stringify(details)+'\n',{mode:0o600});
 const log=await localCommand('journalctl',['--user','--unit='+unitName(run),'--no-pager','--lines=20','--output=cat']).catch(()=> 'Journal unavailable');await writeFile(root+'/synthetic-unit.log',log,{mode:0o600});
}finally{
 let cleaned=true;for(const unit of [...owned].reverse())try{await cleanup(unit);}catch{cleaned=false;process.exitCode=1;}
 await writeFile(root+'/cleanup.json',JSON.stringify({ownedUnitsStopped:cleaned})+'\n',{mode:0o600});
 const names=['inside-protection','effective-limits','native-containment','graceful-cleanup','controller-loss-cleanup'];
 const proof:SupervisionProof={version:2,passed:names.every(n=>checks.get(n)===true)&&cleaned,createdAt:new Date().toISOString(),...await localProofIdentity(),checks:names.map(check=>({check,passed:checks.get(check)===true}))};
 await writeFile(root+'/report.json',JSON.stringify(proof,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({offline:true,evidenceDirectory:root,passed:proof.passed,rootCause,baselineProtected:baseline?.protected??null,baselineWritableInterfaces:baseline?.interfaces.filter(v=>v.writable&&!v.openDenied).length??null,cleanupVerified:cleaned,checks:proof.checks}));
}
