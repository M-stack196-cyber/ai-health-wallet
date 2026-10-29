// Disposable Unix-socket-only PostgreSQL. Never reads application .env or existing DBs.
import {mkdtemp,mkdir,chmod,writeFile,copyFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
const phase2=args[1]==='--phase2',m03=args[1]==='--m03-only',phase3=args[1]==='--phase3',phase4=args[1]==='--phase4',phase5=args[1]==='--phase5';
if(args[0]!=='--execute-isolated'||(args.length!==1&&!((phase2||m03||phase3||phase4||phase5)&&args.length===2)&&!(args.length===3&&args[1]==='--development-schema')))throw Error('Explicit --execute-isolated required.');
const dir=await mkdtemp(join(tmpdir(),'hw-phase1-pg-'));await chmod(dir,0o700);
const root=fileURLToPath(new URL('../../',import.meta.url)),bin=(phase5||process.env.IDENTITY_TEST_PGVECTOR_PREFIX==='/tmp/hw-phase5-pg')?'/tmp/hw-phase5-pg/usr/lib/postgresql/16/bin/':'/usr/lib/postgresql/16/bin/';
if((phase5||process.env.IDENTITY_TEST_PGVECTOR_PREFIX==='/tmp/hw-phase5-pg')&&await (await import('node:fs/promises')).readFile('/tmp/hw-phase5-pg/phase5-owned','utf8')!=='phase5-owned-disposable-postgres\n')throw Error('Owned Phase 5 PostgreSQL prefix required.');
const env={PATH:process.env.PATH,LANG:'C.UTF-8',IDENTITY_TEST_SOCKET:dir};
if(phase3||phase4||phase5){env.XDG_CACHE_HOME=join(dir,'font-cache');await mkdir(env.XDG_CACHE_HOME,{mode:0o700});if(!process.env.PHASE3_PYTHON?.startsWith('/'))throw Error('Explicit absolute PHASE3_PYTHON interpreter required.');env.PHASE3_PYTHON=process.env.PHASE3_PYTHON;}
if(args[2]){const schema=await realpath(args[2]);if(!schema.startsWith(root+'.private-evidence/prd-v2-phase1b-development-'))throw Error('Only the owned development schema checkpoint is allowed.');await copyFile(schema,join(dir,'development-schema.dump'));await chmod(join(dir,'development-schema.dump'),0o600);env.IDENTITY_TEST_SCHEMA_FILE=join(dir,'development-schema.dump');const parent=schema.slice(0,schema.lastIndexOf('/'));for(const name of ['before.dump','checkpoint.json']){await copyFile(join(parent,name),join(dir,'development-'+name));await chmod(join(dir,'development-'+name),0o600);}}
let started=false;
function command(exe,args){const r=spawnSync(exe,args,{cwd:join(root,'backend'),env,encoding:'utf8',timeout:phase3||phase4||phase5?300000:180000,maxBuffer:4*1024*1024});return r;}
try{
 const init=command(bin+'initdb',['-D',join(dir,'data'),'--auth=trust','--no-locale','--encoding=UTF8']);
 await writeFile(join(dir,'init.log'),(init.stdout??'')+(init.stderr??''),{mode:0o600});if(init.status!==0)throw Error('Disposable initdb failed.');
 await writeFile(join(dir,'phase1-owned'),'identity-security-v1\n',{mode:0o600});
 const start=command(bin+'pg_ctl',['-D',join(dir,'data'),'-l',join(dir,'postgres.log'),'-o',"-c listen_addresses='' -k "+dir+" -p 55481 -c unix_socket_permissions=0700 -c log_statement=none -c log_min_error_statement=panic",'-w','start']);
 if(start.status!==0)throw Error('Disposable PostgreSQL start failed.');started=true;
 const run=command(process.execPath,['--import','tsx','--test','--test-concurrency=1',...(phase5?['src/phase5/phase5.test.ts']:phase4?['src/phase4/phase4.test.ts','src/phase4/catalogue.test.ts','src/summary-checks/contracts.check.ts','src/summary-checks/executor.unit.ts']:phase3?['src/phase3/phase3.test.ts','src/documents/storage.test.ts']:m03?['src/documents/closure.test.ts','src/documents/storage.test.ts']:phase2?['src/guardians/phase2.test.ts','src/documents/storage.test.ts']:['src/auth/identity-security.test.ts'])]);
 await writeFile(join(dir,'focused.tap'),(run.stdout??'')+(run.stderr??''),{mode:0o600});
 process.stdout.write(run.stdout??'');process.stderr.write(run.stderr??'');
 if(run.status!==0)process.exitCode=1;
}catch(e){console.error(e.message);process.exitCode=1;}
finally{
 if(started){const stop=command(bin+'pg_ctl',['-D',join(dir,'data'),'-m','fast','-w','stop']);if(stop.status!==0)process.exitCode=1;}
 console.log(JSON.stringify({evidenceDirectory:dir,disposablePostgresStopped:started,network:'unix-socket-only',developmentDatabaseAccessed:false}));
}
