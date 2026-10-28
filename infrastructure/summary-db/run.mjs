import {mkdtemp,mkdir,readFile,writeFile,cp,chmod,lstat,rm,realpath} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {offlineImage} from '../stage-b/offline-image.mjs';
if(process.argv.slice(2).join(' ')!=='--execute-isolated')throw Error('Explicit --execute-isolated required');
const root=fileURLToPath(new URL('../../',import.meta.url));
const run='stage-b-'+randomBytes(12).toString('hex'),dir=await mkdtemp(join(tmpdir(),'health-wallet-summary-db-'));await chmod(dir,0o700);
const snapshot=join(dir,'snapshot');await mkdir(snapshot,{mode:0o700});
const manifest={version:1,run,directory:dir,containers:[],volumes:[],image:'health-wallet-stage-b:'+run,checks:{},cleanup:[]};
const save=()=>writeFile(join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
function docker(args,timeout=30000){const r=spawnSync('docker',args,{encoding:'utf8',timeout,maxBuffer:4*1024*1024});if(r.status!==0){appendFileSync(join(dir,'docker-failure.log'),args[0]+': '+(r.stderr??'Docker unavailable')+'\n',{mode:0o600});throw Error('Docker operation failed: '+args[0]);}return r.stdout.trim();}
const inspect=id=>JSON.parse(docker(['inspect',id]))[0];
const sourceFiles=['backend/package.json','backend/package-lock.json','backend/tsconfig.json','.gitignore','infrastructure/database-roles.sql'];
await writeFile(join(snapshot,'package.json'),JSON.stringify({private:true,type:'module'})+'\n');
await mkdir(join(snapshot,'backend'),{recursive:true});await mkdir(join(snapshot,'infrastructure'),{recursive:true});
for(const path of sourceFiles)await cp(join(root,path),join(snapshot,path));
for(const path of ['backend/src','backend/migrations','shared','infrastructure/stage-b','infrastructure/summary-db'])await cp(join(root,path),join(snapshot,path),{recursive:true,filter:async p=>!(await lstat(p)).isSymbolicLink()});
const secrets={app:randomBytes(32).toString('hex'),migration:randomBytes(32).toString('hex'),admin:randomBytes(32).toString('hex'),jwt:randomBytes(32).toString('hex')};
await writeFile(join(snapshot,'backend/.env'),`DB_HOST=127.0.0.1\nDB_PORT=5433\nDB_NAME=ai_health_wallet\nDB_USER=health_wallet_app\nDB_PASSWORD=${secrets.app}\nJWT_SECRET=${secrets.jwt}\nPROCESSING_SERVICE_ENABLED=false\nDOCUMENT_STORAGE_ENABLED=false\n`,{mode:0o600});
await writeFile(join(snapshot,'backend/.env.migrations'),`MIGRATION_DB_USER=health_wallet_migrator\nMIGRATION_DB_PASSWORD=${secrets.migration}\n`,{mode:0o600});
await writeFile(join(snapshot,'infrastructure/.env'),`POSTGRES_USER=health_wallet_user\nPOSTGRES_DB=ai_health_wallet\nPOSTGRES_PASSWORD=${secrets.admin}\n`,{mode:0o600});
const secretFile=join(dir,'postgres-password');await writeFile(secretFile,secrets.admin,{mode:0o444});
const identity=join(dir,'identity');await writeFile(identity,run,{mode:0o444});
const build=join(dir,'build');await mkdir(join(build,'backend'),{recursive:true});
for(const name of ['package.json','package-lock.json'])await cp(join(snapshot,'backend',name),join(build,'backend',name));
await cp(join(root,'infrastructure/stage-b/Dockerfile'),join(build,'Dockerfile'));
const cache=process.env.STAGE_B_DEPENDENCY_CACHE;
if(cache){
 const info=await lstat(cache);if(!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o777)!==0o700)throw Error('Dependency cache permissions refused');
 const old=JSON.parse(await readFile(join(cache,'manifest.json'),'utf8'));
 const receipt=JSON.parse(await readFile(join(cache,'build/dependencies.json'),'utf8'));
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 if(receipt.node!==process.version||receipt.lockfileSha256!==digest(await readFile(join(root,'backend/package-lock.json'))))throw Error('Dependency cache identity refused');
 for(const [path,hash]of Object.entries(receipt.fingerprints))if(digest(await readFile(path==='/usr/bin/node'?process.execPath:path))!==hash)throw Error('Dependency cache changed');
 const img=JSON.parse(docker(['image','inspect',old.image]))[0];if(img.Config.Labels?.['health-wallet.stage-b']!==old.run||!/^stage-b-[a-f0-9]{24}$/.test(old.run))throw Error('Dependency image provenance refused');
 await writeFile(join(build,'Dockerfile'),'FROM '+img.Id+'\n');await writeFile(join(build,'dependencies.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 manifest.dependencyCacheVerified=true;
 manifest.dependencyImageId=img.Id;manifest.dependencyImageRun=old.run;
}else await offlineImage(build,dirname(dirname(await realpath(join(root,'backend/node_modules')))));
const git=spawnSync('git',['init','--quiet',snapshot],{encoding:'utf8'});if(git.status!==0)throw Error('Isolated Git initialization failed');
await save();console.log(JSON.stringify({run,evidenceDirectory:dir,event:'prepared'}));
try{
 const before=JSON.parse(docker(['ps','-aq','--no-trunc']).split('\n').filter(Boolean).length?JSON.stringify(docker(['ps','-aq','--no-trunc']).split('\n')):'[]');
 manifest.existingContainerIds=before;await save();
 if(manifest.dependencyCacheVerified)docker(['tag',manifest.dependencyImageId,manifest.image]);
 else docker(['build','--network','none','--label','health-wallet.stage-b='+run,'-t',manifest.image,build],600000);
 const pgImage=JSON.parse(docker(['image','inspect','postgres:16']))[0];manifest.postgresImageId=pgImage.Id;await save();
 const volumeName='health-wallet-'+run+'-data';docker(['volume','create','--label','health-wallet.stage-b='+run,volumeName]);manifest.volumes.push(volumeName);await save();
 const pg=docker(['create','--pull=never','--name','health-wallet-'+run+'-postgres','--label','health-wallet.stage-b='+run,'--network','none','--cpus','1','--memory','512m','--pids-limit','128',
  '--cap-drop','ALL','--cap-add','CHOWN','--cap-add','SETUID','--cap-add','SETGID','--cap-add','DAC_OVERRIDE','--cap-add','FOWNER','--security-opt','no-new-privileges',
  '--mount','type=volume,src='+volumeName+',dst=/var/lib/postgresql/data','--mount','type=bind,src='+secretFile+',dst=/run/stage-b-password,readonly',
  '-e','POSTGRES_USER=health_wallet_user','-e','POSTGRES_DB=ai_health_wallet','-e','POSTGRES_PASSWORD_FILE=/run/stage-b-password',
  pgImage.Id,'postgres','-p','5433','-c','listen_addresses=127.0.0.1','-c','log_statement=none','-c','log_min_error_statement=panic']);
 manifest.containers.push(pg);await save();const p=inspect(pg);
 if(p.HostConfig.NetworkMode!=='none'||p.HostConfig.Privileged||Object.keys(p.HostConfig.PortBindings??{}).length||p.HostConfig.Mounts?.some(m=>m.Source?.includes('docker.sock')))throw Error('PostgreSQL isolation refused');
 docker(['start',pg]);
 let ready=false;for(let n=0;n<60;n++){const r=spawnSync('docker',['exec',pg,'pg_isready','-h','127.0.0.1','-p','5433','-U','health_wallet_user','-d','ai_health_wallet'],{encoding:'utf8',timeout:3000});if(r.status===0){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,500));}
 if(!ready)throw Error('Disposable PostgreSQL unavailable');
 const node=docker(['create','--pull=never','--name','health-wallet-'+run+'-tests','--label','health-wallet.stage-b='+run,'--network','container:'+pg,
  '--cpus','2','--memory','3g','--pids-limit','256','--cap-drop','ALL','--security-opt','no-new-privileges','--init',
  '--tmpfs','/tmp:rw,nosuid,nodev,size=268435456,mode=1777',
  '--mount','type=bind,src='+snapshot+',dst=/work','--mount','type=bind,src='+identity+',dst=/stage-b-identity,readonly',
  '-e','STAGE_B_RUN_ID='+run,'-e','PROCESSING_SERVICE_ENABLED=false','-e','AWS_EC2_METADATA_DISABLED=true',
  manifest.image,'sh','-c','cp -a /opt/deps/node_modules /work/backend/node_modules && exec node --import tsx ../infrastructure/summary-db/run-tests.ts']);
 manifest.containers.push(node);await save();const t=inspect(node);
 if(t.HostConfig.NetworkMode!=='container:'+pg||t.HostConfig.Privileged||Object.keys(t.HostConfig.PortBindings??{}).length||t.HostConfig.CapAdd?.length)throw Error('Test runner isolation refused');
 for(const c of [p,t])if(c.Mounts.some(m=>!([snapshot,identity,secretFile].includes(m.Source)||m.Name===volumeName||(m.Type==='tmpfs'&&m.Destination==='/tmp'))))throw Error('Unexpected mount refused');
 manifest.checks={network:'none/shared-private-namespace',publishedPorts:0,privileged:false,bounded:true,mountAllowlist:true};await save();
 docker(['start',node]);const exit=docker(['wait',node],1800000);if(exit!=='0')throw Error('Isolated test sequence failed; private receipts retained');
 manifest.testStatus='passed';
}catch(error){manifest.testStatus='failed';manifest.failure=error instanceof Error?error.message:'Stage B failed';process.exitCode=1;}
finally{
 for(const id of [...manifest.containers].reverse()){
  try{const c=inspect(id);if(c.Id!==id||c.Config.Labels?.['health-wallet.stage-b']!==run||manifest.existingContainerIds?.includes(id))throw Error('Identity mismatch');
   const logs=spawnSync('docker',['logs',id],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});
   await writeFile(join(dir,'container-'+manifest.containers.indexOf(id)+'.log'),(logs.stdout??'')+(logs.stderr??''),{mode:0o600});
   docker(['stop','-t','15',id],60000);docker(['rm',id],60000);manifest.cleanup.push({kind:'container',status:'removed'});
  }catch{manifest.cleanup.push({kind:'container',status:'retained-identity-or-cleanup-failure'});process.exitCode=1;}
 }
 for(const name of manifest.volumes){try{const v=JSON.parse(docker(['volume','inspect',name]))[0];if(v.Name!==name||v.Labels?.['health-wallet.stage-b']!==run)throw Error('Volume identity mismatch');
   docker(['volume','rm',name],60000);manifest.cleanup.push({kind:'volume',status:'removed'});
  }catch{manifest.cleanup.push({kind:'volume',status:'retained-identity-or-cleanup-failure'});process.exitCode=1;}}
 try{const img=JSON.parse(docker(['image','inspect',manifest.image]))[0];if(img.Config.Labels?.['health-wallet.stage-b']!==(manifest.dependencyImageRun??run)||(manifest.dependencyImageId&&img.Id!==manifest.dependencyImageId))throw Error('Image identity mismatch');
   docker(['image','rm',manifest.image]);manifest.cleanup.push({kind:'image',status:'removed'});
 }catch{manifest.cleanup.push({kind:'image',status:'not-removed-or-not-created'});}
 await save();
 try{const report=JSON.parse(await readFile(join(snapshot,'results/report.json'),'utf8'));console.log(JSON.stringify({report}));}catch{}
 console.log(JSON.stringify({event:'finished',status:manifest.testStatus,cleanup:manifest.cleanup,evidenceDirectory:dir}));
}
