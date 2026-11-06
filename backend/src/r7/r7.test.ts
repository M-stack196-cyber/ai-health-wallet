import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir,stat,writeFile,mkdtemp,mkdir,chmod,symlink,copyFile,rm,access} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import pg from 'pg';
import {databaseTls} from '../config/env.js';
import {trustProxyHops} from '../config/proxy.js';
import {migrationTargetProblem} from '../database/migration-target.js';
import {stagingEnvironmentProblems,secretVariableNames} from '../stage-c/staging-environment.js';
import {ragClientFromEnvironment} from '../rag/client.js';

// Phase R7: deployment readiness of the disposable single-node staging (us-east-1). Nothing here touches AWS or a real
// database: static checks on the build files, real local container builds (when Docker is available), and a backup/restore
// drill on a disposable PostgreSQL. Synthetic data only.
const run=promisify(execFile);
const root=new URL('../../../',import.meta.url).pathname,staging=root+'infrastructure/staging/';
const socket=process.env.IDENTITY_TEST_SOCKET;
if(!socket||!/^\/tmp\/hw-phase1-pg-[a-zA-Z0-9]+$/.test(socket))throw Error('Only the test-owned Unix socket is allowed.');
const text=(path:string)=>readFile(path,'utf8');
const sh=async(cmd:string,args:string[],opts:{env?:NodeJS.ProcessEnv;timeout?:number;cwd?:string}={})=>{try{const r=await run(cmd,args,{env:opts.env??process.env,timeout:opts.timeout??120000,maxBuffer:64*1024*1024,cwd:opts.cwd});return {code:0,stdout:r.stdout,stderr:r.stderr};}catch(e:any){return {code:typeof e.code==='number'?e.code:1,stdout:String(e.stdout??''),stderr:String(e.stderr??'')};}};
const dockerReady=await sh('docker',['info'],{timeout:20000}).then(r=>r.code===0);
const composeReady=dockerReady&&(await sh('docker',['compose','version'],{timeout:20000})).code===0;
const dockerfiles=['backend.Dockerfile','ai-service.Dockerfile','web.Dockerfile'];
const SECRETY=/(SECRET|PASSWORD|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|ENCRYPTION_KEY)/i;

// ---------------------------------------------------------------- build files
test('R7-01 Dockerfiles: pinned bases, non-root runtime, no secrets, reproducible installs',async()=>{
 for(const name of dockerfiles){
  const src=await text(staging+name),lines=src.split('\n').filter(l=>l.trim()&&!l.trim().startsWith('#'));
  const froms=lines.filter(l=>/^FROM\s/i.test(l));assert.ok(froms.length>=1,name);
  for(const f of froms)assert.match(f,/^FROM\s+(?:--platform=\S+\s+)?[a-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}(?:\s+AS\s+\w+)?$/i,name+': every base image is pinned by digest: '+f);
  assert.ok(!/:latest\b/.test(src),name+': no latest tag');
  const last=src.slice(src.lastIndexOf('\nFROM '));
  assert.match(last,/\nUSER\s+(?!root\b|0\b)\S+/,name+': the final stage runs as a non-root user');
  if(/\n(CMD|ENTRYPOINT)\s/.test(last))assert.ok(last.indexOf('USER ')<last.search(/\n(CMD|ENTRYPOINT)\s/),name+': the user is set before the command');
  assert.ok(!/^\s*(ENV|ARG)\s+\S*(SECRET|PASSWORD|TOKEN|KEY|CREDENTIAL)\S*\s*=?\s*\S+/im.test(src),name+': no secret-like ENV/ARG');
  assert.ok(!/\bADD\s+https?:/i.test(src)&&!/curl[^\n]*\|\s*(ba)?sh/i.test(src)&&!/wget[^\n]*\|\s*(ba)?sh/i.test(src),name+': nothing downloaded and executed');
  assert.ok(!/COPY[^\n]*(\.env|\.aws|\.ssh|\.pem|\.private-evidence|credentials|secrets\/)/.test(src),name+': no secret paths copied');
  assert.ok(!/npm\s+install\b/.test(src),name+': npm ci only');
  if(/apt-get install/.test(src)){assert.match(src,/--no-install-recommends/);assert.match(src,/rm -rf \/var\/lib\/apt\/lists/);}
  assert.ok(!/ap-southeast-2|402909940531/.test(src));
 }
 assert.match(await text(staging+'backend.Dockerfile'),/COPY backend\/migrations \.\/migrations/,'migrations ship with the API image');
 assert.match(await text(staging+'backend.Dockerfile'),/tsconfig\.build\.json/,'tests are not compiled into the API image');
 assert.match(await text(staging+'ai-service.Dockerfile'),/USER 10001:10001/);assert.match(await text(staging+'web.Dockerfile'),/USER 101:101/);
 const build=JSON.parse(await text(root+'backend/tsconfig.build.json'));assert.ok(build.exclude.includes('src/**/*.test.ts')&&build.exclude.includes('src/phase*/**'));
});

test('R7-02 .dockerignore keeps secrets, evidence, dumps, local state and dependencies out of every build context',async()=>{
 const rules=(await text(root+'.dockerignore')).split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
 for(const must of ['**/.env','**/.env.*','**/.aws','**/.ssh','**/.private-evidence','.private-evidence','**/*.pem','**/*.key','**/*.dump','.git','**/node_modules','**/venv','**/__pycache__','docs'])assert.ok(rules.includes(must),'ignored: '+must);
 assert.ok(rules.includes('!**/.env.example'));
 if(!dockerReady)return;
 // Real probe: send the actual context to Docker and list what arrived.
 const probe=await mkdtemp(join(tmpdir(),'hw-r7-probe-'));await writeFile(probe+'/Dockerfile',"FROM alpine:latest\nCOPY . /ctx\nRUN find /ctx \\( -name '.env' -o \\( -name '.env.*' ! -name '*.example' \\) -o -name '*.pem' -o -name '*.key' -o -name '*.dump' -o -name '.aws' -o -name '.private-evidence' -o -name node_modules -o -name venv -o -name '.git' -o -name '__pycache__' \\) -prune -print > /found.txt && cat /found.txt && test ! -s /found.txt\n");
 const r=await sh('docker',['build','--no-cache','--progress=plain','-f',probe+'/Dockerfile','-t','hw-r7-context-probe',root],{timeout:600000});
 await sh('docker',['rmi','-f','hw-r7-context-probe']);await rm(probe,{recursive:true,force:true});
 assert.equal(r.code,0,'sensitive paths reached the build context:\n'+r.stderr.slice(-600));
});

test('R7-03 compose: single node, hardened containers, file-based secrets, no database container, private ports, us-east-1',async()=>{
 if(!composeReady)return;
 const dummy:Record<string,string>={HW_API_IMAGE:'hw-staging-api:r7',HW_AI_IMAGE:'hw-staging-ai:r7',HW_WEB_IMAGE:'hw-staging-web:r7',SECRETS_DIR:'/srv/hw/secrets',RDS_ENDPOINT:'hwstaging.abcdefghijkl.us-east-1.rds.amazonaws.com',RDS_CA_BUNDLE:'/srv/hw/rds-ca.pem',AWS_ACCOUNT_ID:'123456789012',S3_BUCKET:'hw-staging-records',S3_KMS_KEY_ARN:'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',DOCTOR_ORIGIN:'https://doctor.staging.example.invalid'};
 const cfg=(env:Record<string,string>,profiles=true)=>sh('docker',['compose','-f',staging+'docker-compose.staging.yml',...(profiles?['--profile','optional']:[]),'config','--format','json'],{env:{PATH:process.env.PATH??'',HOME:process.env.HOME??'',...env}});
 const ok=await cfg(dummy);assert.equal(ok.code,0,ok.stderr.slice(0,400));const c=JSON.parse(ok.stdout);
 assert.deepEqual(Object.keys(c.services).sort(),['api','ocr','rag','summary','web']);
 assert.ok(!Object.keys(c.services).some(n=>/postgres|db|database/.test(n)),'no database container: PostgreSQL is external RDS');
 for(const [name,s] of Object.entries<any>(c.services)){
  assert.equal(s.read_only,true,name+' read-only root');assert.deepEqual(s.cap_drop,['ALL'],name);assert.deepEqual(s.security_opt,['no-new-privileges:true'],name);
  assert.ok(Number(s.pids_limit)>0&&Number(s.mem_limit)>0&&Number(s.cpus)>0,name+' resource limits');assert.equal(s.restart,'unless-stopped',name);
  assert.ok(!s.privileged&&!s.pid&&!s.ipc&&s.network_mode!=='host',name+' no privileged, host pid/ipc/network');
  assert.ok((s.volumes??[]).every((v:any)=>v.read_only===true&&v.type==='bind'),name+': the only mounts are read-only');
  assert.ok(!(s.volumes??[]).some((v:any)=>/docker\.sock/.test(v.source)),name);
  const env=s.environment??{};for(const [k,v] of Object.entries<any>(env))if(SECRETY.test(k))assert.ok(/_FILE$/.test(k)&&String(v).startsWith('/run/secrets/'),name+': '+k+' is a file path, not a value');
  assert.ok(!Object.keys(env).some(k=>/^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)$/.test(k)),name+': no static AWS credentials (instance role only)');
 }
 for(const n of ['rag','summary','ocr'])assert.equal(c.services[n].network_mode,'service:api',n+' shares the API loopback and has no network of its own');
 assert.ok(!c.services.rag.ports&&!c.services.api.ports,'only the web container publishes ports');
 assert.deepEqual(c.services.web.ports.map((p:any)=>[p.host_ip,p.published,p.target]).sort(),[['127.0.0.1','8080',8080],['127.0.0.1','8081',8081]],'web listens on loopback only; the TLS terminator is the public entry');
 const api=c.services.api.environment;assert.equal(api.AWS_REGION,'us-east-1');assert.equal(api.DB_PORT,'5432');assert.equal(api.NODE_ENV,'production');
 assert.deepEqual(stagingEnvironmentProblems(api),[],'the API service definition satisfies the staging environment policy');
 assert.deepEqual(Object.keys(c.secrets).sort(),['admin_jwt_secret','db_app_password','jwt_secret','ocr_service_token','rag_service_token','summary_service_token']);
 for(const s of Object.values<any>(c.secrets))assert.ok(s.file.startsWith('/srv/hw/secrets/'),'secrets come from the operator-managed directory');
 assert.ok(c.services.summary.profiles?.includes('optional')&&c.services.ocr.profiles?.includes('optional'),'summary and OCR are off unless explicitly enabled');
 // fails closed when an owner-provided input is missing
 for(const missing of Object.keys(dummy)){const {[missing]:_,...rest}=dummy;const r=await cfg(rest);assert.notEqual(r.code,0,'compose refuses to start without '+missing);}
 // the file never names the older ap-southeast-2 account/region used by earlier live-verification tooling
 const raw=await text(staging+'docker-compose.staging.yml');assert.ok(!/ap-southeast-2|402909940531/.test(raw));assert.ok(!/AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY/.test(raw));
 const example=await text(staging+'staging.env.example');for(const line of example.split('\n').filter(l=>l&&!l.startsWith('#')))assert.match(line,/^[A-Z0-9_]+=(?:2)?$/,'the example holds names only: '+line);
});

test('R7-04 nginx: separate doctor and admin origins, admin routes reachable only from the admin origin, security headers',async()=>{
 const conf=await text(staging+'nginx.conf');
 assert.match(conf,/server_tokens off;/);assert.match(conf,/listen 8080;/);assert.match(conf,/listen 8081;/);
 const [doctor,admin]=conf.split(/\nserver \{/).slice(1);
 assert.match(doctor,/location \/api\/v1\/admin\/ \{ return 404; \}/,'doctor origin never forwards admin routes');
 assert.match(admin,/location \/api\/v1\/admin\/ \{[^}]*proxy_pass/s);assert.match(admin,/location \/api\/ \{ return 404; \}/,'admin origin forwards nothing else');
 for(const [name,block] of [['doctor',doctor],['admin',admin]])for(const header of ['X-Content-Type-Options "nosniff"','X-Frame-Options "DENY"','Referrer-Policy "no-referrer"',"frame-ancestors 'none'","default-src 'self'","script-src 'self'"])assert.ok(block.includes(header),name+' has '+header);
 assert.ok(!/script-src[^;]*unsafe-(inline|eval)/.test(conf),'no inline or eval scripts');assert.ok(!/Access-Control-Allow-Origin/.test(conf),'no cross-origin access');
 assert.match(conf,/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/,'client address is passed on for per-client rate limits');
 assert.match(admin,/client_max_body_size 64k;/,'admin accepts only small bodies');assert.match(doctor,/client_max_body_size 6m;/);
 assert.ok(!/ap-southeast-2|402909940531/.test(conf));
});

// ---------------------------------------------------------------- secrets and configuration
test('R7-05 secret loading: values come from files, are never printed, and unsafe files are refused',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hw-r7-secrets-')),script=staging+'load-secrets.sh',value='Syn-'+randomBytes(24).toString('hex');
 const file=async(name:string,body:string,mode=0o600)=>{const p=join(dir,name);await writeFile(p,body,{mode});await chmod(p,mode);return p;};
 const child=['sh','-c','printf "%s|%s|%s" "${JWT_SECRET:-unset}" "${JWT_SECRET_FILE:-gone}" "${#JWT_SECRET}"'];
 const exec=(env:Record<string,string>,cmd=child)=>sh('sh',[script,...cmd],{env:{PATH:process.env.PATH??'',...env}});
 const good=await file('jwt',value+'\n');
 let r=await exec({JWT_SECRET_FILE:good});assert.equal(r.code,0);assert.equal(r.stdout,`${value}|gone|${value.length}`,'trailing newline stripped; the *_FILE variable is removed from the child');assert.equal(r.stderr,'');
 r=await exec({},child);assert.equal(r.stdout,'unset|gone|0','nothing is loaded when no file is named');
 r=await exec({JWT_SECRET_FILE:await file('mode644',value,0o644)});assert.equal(r.code,0,'read-only to others is fine (compose secrets are 0444)');
 const refusals:Record<string,Record<string,string>>={
  'missing file':{JWT_SECRET_FILE:join(dir,'nope')},'directory':{JWT_SECRET_FILE:dir},'empty file':{JWT_SECRET_FILE:await file('empty','')},'only a newline':{JWT_SECRET_FILE:await file('nl','\n')},
  'too large':{JWT_SECRET_FILE:await file('big','x'.repeat(4097))},'several lines':{JWT_SECRET_FILE:await file('multi','a\nb\n')},'group-writable':{JWT_SECRET_FILE:await file('gw',value,0o620)},'world-writable':{JWT_SECRET_FILE:await file('ww',value,0o602)},
  'both plain and file':{JWT_SECRET_FILE:good,JWT_SECRET:'plain'},
 };
 await symlink(good,join(dir,'link'));refusals['symbolic link']={JWT_SECRET_FILE:join(dir,'link')};
 for(const [name,env] of Object.entries(refusals)){const r=await exec(env);assert.equal(r.code,78,name);assert.equal(r.stdout,'',name+': the command never ran');assert.match(r.stderr,/^Secret loading refused: JWT_SECRET/,name);assert.ok(!r.stderr.includes(value)&&!r.stderr.includes('plain'),name+': no value in the message');}
 r=await exec({JWT_SECRET_FILE:good,SOME_OTHER_SECRET_FILE:good});assert.equal(r.code,0);
 r=await sh('sh',[script,'sh','-c','printf "%s" "${SOME_OTHER_SECRET:-unset}"'],{env:{PATH:process.env.PATH??'',SOME_OTHER_SECRET_FILE:good}});assert.equal(r.stdout,'unset','only allow-listed names are ever loaded');
 assert.equal((await sh('sh',[script],{env:{PATH:process.env.PATH??''}})).code,78,'no command given');
 // the allow-list in the script matches the application's secret names exactly
 const names=[...(await text(script)).match(/for name in([^;]*?); do/s)![1].matchAll(/[A-Z_]+/g)].map(m=>m[0]).sort();assert.deepEqual(names,[...secretVariableNames].sort());
 // several secrets at once, and a final value that contains shell metacharacters stays inert
 const tricky='a$(touch '+dir+'/pwned)`id`;"\' b';r=await exec({JWT_SECRET_FILE:await file('tricky',tricky),DB_PASSWORD_FILE:good},['sh','-c','printf "%s" "$JWT_SECRET" | wc -c; printf "%s" "$DB_PASSWORD" | wc -c']);
 assert.equal(r.code,0);await assert.rejects(access(join(dir,'pwned')),'secret contents are never executed');
 await rm(dir,{recursive:true,force:true});
});

test('R7-06 staging configuration rules: TLS to the database, guarded migration target, proxy hops, no static AWS keys, synthetic-only modes',async()=>{
 // database link
 assert.equal(databaseTls('/tmp/sock',{}),undefined);assert.equal(databaseTls('127.0.0.1',{}),undefined);
 assert.throws(()=>databaseTls('hw.abcdefghijkl.us-east-1.rds.amazonaws.com',{}),/DB_SSL_CA_FILE is required/);
 const dir=await mkdtemp(join(tmpdir(),'hw-r7-tls-')),ca=join(dir,'ca.pem'),bad=join(dir,'bad.pem');await writeFile(ca,'-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');await writeFile(bad,'not a certificate');
 const tls=databaseTls('hw.abcdefghijkl.us-east-1.rds.amazonaws.com',{DB_SSL_CA_FILE:ca});assert.equal(tls?.rejectUnauthorized,true);assert.equal(tls?.minVersion,'TLSv1.2');assert.ok(tls?.ca.includes('BEGIN CERTIFICATE'));
 assert.throws(()=>databaseTls('h.example.invalid',{DB_SSL_CA_FILE:bad}),/PEM/);assert.throws(()=>databaseTls('h.example.invalid',{DB_SSL_CA_FILE:join(dir,'missing')}),/cannot be read/);
 // migration target
 const rds={host:'hwstaging.abcdefghijkl.us-east-1.rds.amazonaws.com',port:5432,database:'ai_health_wallet_staging'},env={MIGRATION_TARGET:'staging',MIGRATION_CONFIRM_HOST:rds.host,DB_SSL_CA_FILE:ca};
 assert.equal(migrationTargetProblem(rds,env),undefined);
 for(const [name,t,e] of [['other region',{...rds,host:'hwstaging.abcdefghijkl.ap-southeast-2.rds.amazonaws.com'},{...env,MIGRATION_CONFIRM_HOST:'hwstaging.abcdefghijkl.ap-southeast-2.rds.amazonaws.com'}],['not RDS',{...rds,host:'db.example.com'},{...env,MIGRATION_CONFIRM_HOST:'db.example.com'}],['look-alike host',{...rds,host:'x.us-east-1.rds.amazonaws.com.evil.example'},{...env,MIGRATION_CONFIRM_HOST:'x.us-east-1.rds.amazonaws.com.evil.example'}],
  ['wrong port',{...rds,port:5433},env],['wrong database',{...rds,database:'postgres'},env],['no confirmation',rds,{...env,MIGRATION_CONFIRM_HOST:undefined}],['wrong confirmation',rds,{...env,MIGRATION_CONFIRM_HOST:'other.abcdefghijkl.us-east-1.rds.amazonaws.com'}],['no TLS',rds,{...env,DB_SSL_CA_FILE:undefined}],['unknown mode',rds,{...env,MIGRATION_TARGET:'production'}]] as const)
  assert.ok(migrationTargetProblem(t as any,e as any),name);
 assert.equal(migrationTargetProblem({host:'127.0.0.1',port:5433,database:'ai_health_wallet'},{}),undefined,'the local development rule is unchanged');
 assert.ok(migrationTargetProblem(rds,{}),'an RDS host is refused unless staging is explicitly chosen');assert.ok(migrationTargetProblem({host:'localhost',port:5433,database:'ai_health_wallet'},{}));
 // reverse proxy
 assert.equal(trustProxyHops({}),0);assert.equal(trustProxyHops({TRUST_PROXY_HOPS:'2'}),2);for(const v of ['-1','4','x','1.5',' 1','true'])assert.throws(()=>trustProxyHops({TRUST_PROXY_HOPS:v}),/TRUST_PROXY_HOPS/,v);
 // the API is wired to the AI service from its environment (it was not before R7)
 assert.equal(ragClientFromEnvironment({}),undefined);assert.ok(ragClientFromEnvironment({RAG_PROVIDER:'synthetic-offline',RAG_SERVICE_URL:'http://127.0.0.1:8013/internal/v1/rag/',RAG_SERVICE_TOKEN:'ab12cd34'.repeat(8)}));
 for(const e of [{RAG_SERVICE_URL:'http://127.0.0.1:8013/internal/v1/rag/',RAG_SERVICE_TOKEN:'ab12cd34'.repeat(8)},{RAG_PROVIDER:'hosted',RAG_SERVICE_URL:'http://127.0.0.1:8013/internal/v1/rag/',RAG_SERVICE_TOKEN:'ab12cd34'.repeat(8)},{RAG_PROVIDER:'synthetic-offline',RAG_SERVICE_URL:'http://10.0.0.5:8013/internal/v1/rag/',RAG_SERVICE_TOKEN:'ab12cd34'.repeat(8)},{RAG_PROVIDER:'synthetic-offline',RAG_SERVICE_URL:'https://ai.example.com/internal/v1/rag/',RAG_SERVICE_TOKEN:'ab12cd34'.repeat(8)},{RAG_PROVIDER:'synthetic-offline',RAG_SERVICE_URL:'http://127.0.0.1:8013/internal/v1/rag/',RAG_SERVICE_TOKEN:'short'}])assert.throws(()=>ragClientFromEnvironment(e));
 // environment policy
 const good:Record<string,string>={NODE_ENV:'production',AWS_REGION:'us-east-1',DOCUMENT_STORAGE_ENABLED:'true',S3_BUCKET:'hw-staging-records',S3_BUCKET_OWNER_ACCOUNT_ID:'123456789012',S3_ENCRYPTION:'aws:kms',S3_KMS_KEY_ARN:'arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',DB_HOST:rds.host,DB_PORT:'5432',DB_NAME:'ai_health_wallet_staging',DB_USER:'health_wallet_app',DB_SSL_CA_FILE:'/etc/ssl/rds/global-bundle.pem',DB_PASSWORD_FILE:'/run/secrets/db',JWT_SECRET_FILE:'/run/secrets/jwt',TRUST_PROXY_HOPS:'2',FRONTEND_ORIGIN:'https://doctor.staging.example.invalid',AUTH_SECURITY_EMAIL_MODE:'disabled',GUARDIAN_NOTIFICATIONS_MODE:'disabled',PROCESSING_SERVICE_ENABLED:'false',RAG_PROVIDER:'synthetic-offline',RAG_SERVICE_URL:'http://127.0.0.1:8013/internal/v1/rag/'};
 assert.deepEqual(stagingEnvironmentProblems(good),[]);
 const mutate=(change:Record<string,string|undefined>)=>stagingEnvironmentProblems({...good,...change}).join(',');
 const cases:Array<[Record<string,string|undefined>,string]>=[[{AWS_REGION:'ap-southeast-2'},'AWS_REGION'],[{JWT_SECRET:'plain'},'SECRET_AS_PLAIN_VALUE:JWT_SECRET'],[{DB_PASSWORD:'plain'},'SECRET_AS_PLAIN_VALUE:DB_PASSWORD'],[{AWS_ACCESS_KEY_ID:'AKIAEXAMPLE'},'STATIC_AWS_CREDENTIAL_OR_ENDPOINT:AWS_ACCESS_KEY_ID'],[{AWS_ENDPOINT_URL_S3:'http://x'},'STATIC_AWS_CREDENTIAL_OR_ENDPOINT:AWS_ENDPOINT_URL_S3'],
  [{S3_ENCRYPTION:'AES256'},'S3_ENCRYPTION'],[{S3_KMS_KEY_ARN:'arn:aws:kms:ap-southeast-2:123456789012:key/x'},'S3_ENCRYPTION'],[{DB_HOST:'db.example.com'},'DB_HOST'],[{DB_NAME:'ai_health_wallet'},'DB_NAME'],[{DB_USER:'postgres'},'DB_USER'],[{DB_SSL_CA_FILE:undefined},'DB_SSL_CA_FILE'],[{NODE_ENV:'development'},'NODE_ENV'],
  [{AUTH_SECURITY_EMAIL_MODE:'https-relay'},'AUTH_SECURITY_EMAIL_MODE'],[{GUARDIAN_NOTIFICATIONS_MODE:'live'},'GUARDIAN_NOTIFICATIONS_MODE'],[{PROCESSING_SERVICE_ENABLED:'true'},'MUST_BE_FALSE:PROCESSING_SERVICE_ENABLED'],[{RAG_PROVIDER:'hosted'},'PROVIDER_NOT_APPROVED:RAG_PROVIDER'],[{RAG_SERVICE_URL:'http://10.0.0.9:8013/'},'RAG_SERVICE_URL'],[{TRUST_PROXY_HOPS:undefined},'TRUST_PROXY_HOPS'],[{JWT_SECRET_FILE:undefined},'MISSING:JWT_SECRET_FILE'],[{DOCUMENT_STORAGE_ENABLED:'false'},'DOCUMENT_STORAGE_ENABLED']];
 for(const [change,code] of cases)assert.ok(mutate(change).includes(code),code+' <- '+JSON.stringify(change).slice(0,60));
 assert.ok(!stagingEnvironmentProblems({...good,JWT_SECRET:'S3cr3tValue-123'}).join(',').includes('S3cr3tValue'),'problem codes never carry values');
 await rm(dir,{recursive:true,force:true});
});

// ---------------------------------------------------------------- backup, restore and recovery (CFG-09 / V-21 drill, local)
const owner=new pg.Pool({host:socket,port:55481,user:userInfo().username,database:'postgres'});
const dbEnv=(database:string,user=userInfo().username):NodeJS.ProcessEnv=>({PATH:process.env.PATH??'',PGHOST:socket,PGPORT:'55481',PGUSER:user,PGDATABASE:database});
const recovery=staging+'db-recovery.mjs';
const cli=(args:string[],env:NodeJS.ProcessEnv)=>sh('node',[recovery,...args],{env,timeout:300000});
const q=async(database:string,sql:string,values:unknown[]=[],user=userInfo().username)=>{const c=new pg.Client({host:socket,port:55481,user,database});await c.connect();try{return (await c.query(sql,values)).rows;}finally{await c.end();}};
let backupDir='',backupFile='',seeded:{emails:string[];names:string[]}={emails:[],names:[]};
before(async()=>{
 if(!(await owner.query("SELECT 1 FROM pg_roles WHERE rolname='health_wallet_app'")).rows.length){await owner.query('CREATE ROLE health_wallet_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await owner.query('CREATE ROLE health_wallet_migrator NOLOGIN');}
 for(const name of ['hw_r7_source','hw_r7_target_restore','hw_r7_second_restore','hw_r7_live'])await owner.query('CREATE DATABASE '+name);
 const files=(await readdir(new URL('../../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort();assert.equal(files.length,21);
 const c=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'hw_r7_source'});await c.connect();
 try{
  await c.query('CREATE EXTENSION IF NOT EXISTS vector');
  for(const f of files){if(f.startsWith('0005'))await c.query('GRANT USAGE ON SCHEMA public TO health_wallet_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO health_wallet_app');await c.query('BEGIN');try{await c.query(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}}
  await c.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations(version TEXT PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`);
  const {createHash}=await import('node:crypto');
  for(const f of files)await c.query('INSERT INTO public.schema_migrations(version,name,checksum) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[f.slice(0,4),f,createHash('sha256').update(await readFile(new URL('../../migrations/'+f,import.meta.url),'utf8')).digest('hex')]);
  for(let i=0;i<25;i++){const email='r7-'+randomUUID()+'@example.invalid',name='Synthetic R7 Person '+i;seeded.emails.push(email);seeded.names.push(name);
   const id=randomUUID();await c.query("INSERT INTO patients(id,email,password_hash,full_name,email_verified_at,account_status) VALUES($1,$2,'$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaGZpeHR1cmU',$3,clock_timestamp(),'active')",[id,email,name]);
   await c.query("INSERT INTO medical_documents(patient_id,s3_bucket,s3_object_key,original_filename,file_type,category,hospital_name,processing_status,content_type,size_bytes,sha256) VALUES($1,'synthetic-private-bucket',$2,'synthetic.pdf','pdf','lab_report','Synthetic Hospital','failed','application/pdf',24,$3)",[id,'medical-documents/'+randomUUID()+'.pdf','02be06dafdca1e35e82ce33d549485f29627c07274b644fafb0e54befbe732de']);}
 }finally{await c.end();}
 backupDir=await mkdtemp(join(tmpdir(),'hw-r7-backup-'));
});
after(async()=>{for(const name of ['hw_r7_source','hw_r7_target_restore','hw_r7_second_restore','hw_r7_live'])await owner.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});await owner.end();if(backupDir)await rm(backupDir,{recursive:true,force:true});});

test('R7-07 backup: consistent snapshot, owner-only files, a manifest with counts and checksums but no personal data',async()=>{
 const writer=new pg.Client({host:socket,port:55481,user:userInfo().username,database:'hw_r7_source'});await writer.connect();let stop=false,written=0;
 const loop=(async()=>{while(!stop){await writer.query("INSERT INTO patients(email,password_hash,full_name) VALUES($1,'$argon2id$v=19$m=19456,t=2,p=1$c3ludGhldGljc2FsdA$c3ludGhldGljaGFzaGZpeHR1cmU','Concurrent Synthetic')",['live-'+randomUUID()+'@example.invalid']);written++;}})();
 const r=await cli(['backup','--out',backupDir+'/nested/out'],dbEnv('hw_r7_source'));stop=true;await loop;await writer.end();
 assert.equal(r.code,0,r.stderr);assert.equal(r.stderr,'');const out=JSON.parse(r.stdout);assert.equal(out.ok,true);assert.ok(written>0,'writes were happening during the backup');
 backupFile=out.file;const manifestFile=backupFile.replace(/\.dump$/,'.manifest.json');
 assert.equal((await stat(backupDir+'/nested/out')).mode&0o777,0o700);assert.equal((await stat(backupFile)).mode&0o777,0o600);assert.equal((await stat(manifestFile)).mode&0o777,0o600);
 assert.deepEqual((await readdir(backupDir+'/nested/out')).sort(),[backupFile.split('/').pop(),manifestFile.split('/').pop()].sort(),'no partial file is left behind');
 const m=JSON.parse(await text(manifestFile));assert.equal(m.format,1);assert.equal(m.encrypted,false,'the file is not encrypted: it must be stored only on encrypted storage');assert.equal(m.ledger.length,21);assert.ok(m.tables.patients.rows>=25&&m.tables.patients.rls===false);assert.ok(Object.values<any>(m.tables).some(t=>t.rls===true),'row-level security state is recorded');
 assert.ok(m.policies>0&&m.appGrants>0&&m.extensions.includes('vector'));assert.match(m.sha256,/^[a-f0-9]{64}$/);assert.equal(m.sha256,(await sh('sha256sum',[backupFile])).stdout.split(' ')[0]);
 const raw=await text(manifestFile);for(const secret of [...seeded.emails,...seeded.names,'argon2id',socket,userInfo().username])assert.ok(!raw.includes(secret)&&!r.stdout.includes(secret),'the manifest and output carry no personal data, hash, socket path or account name');
 // the counts are a snapshot: never more than the source holds afterwards, never fewer than the seeded rows (a full check follows in the restore drill)
 assert.ok(m.tables.patients.rows>=25&&m.tables.patients.rows<=Number((await q('hw_r7_source','SELECT count(*) AS n FROM patients'))[0].n));
 // the application role must never take backups (it sees only rows allowed by row-level security)
 const refused=await cli(['backup','--out',backupDir+'/app'],dbEnv('hw_r7_source','health_wallet_app'));assert.equal(refused.code,1);assert.match(refused.stderr,/^Refused: backup must run as the schema owner/);
 assert.equal((await cli(['backup'],dbEnv('hw_r7_source'))).code,2,'usage error');
});

test('R7-08 restore drill: a disaster is recovered into a fresh database and verified against the manifest, then the application role still has its limits',async()=>{
 const started=Date.now(),r=await cli(['restore','--backup',backupFile],dbEnv('hw_r7_target_restore'));
 assert.equal(r.code,0,r.stdout+r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.ok,true,JSON.stringify(out.problems));assert.deepEqual(out.problems,[]);assert.equal(out.migrations,21);assert.ok(out.rows>=25);
 const observedMs=Date.now()-started;assert.ok(observedMs<180000,'observed recovery time on a tiny synthetic database: '+observedMs+' ms (not an approved RTO)');
 // exact equality with the source as it was at the snapshot
 const m=JSON.parse(await text(backupFile.replace(/\.dump$/,'.manifest.json')));
 for(const [table,t] of Object.entries<any>(m.tables))assert.equal(Number((await q('hw_r7_target_restore','SELECT count(*) AS n FROM public."'+table+'"'))[0].n),t.rows,table);
 assert.deepEqual((await q('hw_r7_target_restore','SELECT version,name,checksum FROM public.schema_migrations ORDER BY version')).map(x=>x.version),m.ledger.map((x:any)=>x.version));
 // access controls came back with the data
 const app=(sql:string,values:unknown[]=[])=>q('hw_r7_target_restore',sql,values,'health_wallet_app');
 for(const sql of ["INSERT INTO public.admin_accounts(email,password_hash,full_name,role_name) VALUES('x@example.invalid','$argon2id$x','X','support_admin')","UPDATE public.patient_deletion_requests SET state='policy_pending'","DELETE FROM public.patient_deletion_audit","CREATE TABLE public.sneaky(x int)","INSERT INTO public.guardian_serious_rules(id,version,definition,definition_sha256,approval_status,approval_metadata) VALUES('R7_X','1','{}',repeat('a',64),'clinically_approved','{\"qualified_approver\":\"x\",\"approval_reference\":\"y\"}')"])
  await assert.rejects(app(sql),(e:any)=>e.code==='42501','still refused after restore: '+sql.slice(0,50));
 const rls=await q('hw_r7_target_restore',"SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity");assert.ok(rls[0].n>0);
 assert.equal((await q('hw_r7_target_restore',"SELECT count(*)::int n FROM pg_trigger WHERE tgname IN ('patient_deletion_state_guard','guardian_serious_rule_approval_guard')"))[0].n,2,'safety triggers were restored');
 // "failover" on a single node = point the service at the restored database; that is a configuration change, nothing else moves
 assert.equal((await app('SELECT current_database() AS d'))[0].d,'hw_r7_target_restore');
});

test('R7-09 restore refuses anything unsafe before it touches a database',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hw-r7-bad-')),base=backupFile.split('/').pop()!.replace(/\.dump$/,''),copy=async(label:string)=>{const d=join(dir,label);await mkdir(d,{mode:0o700});await copyFile(backupFile,join(d,base+'.dump'));await copyFile(backupFile.replace(/\.dump$/,'.manifest.json'),join(d,base+'.manifest.json'));return join(d,base+'.dump');};
 const empty=async(db:string)=>Number((await q(db,"SELECT count(*) AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'"))[0].n)===0;
 const target=dbEnv('hw_r7_second_restore'),expectRefused=async(label:string,file:string,env:NodeJS.ProcessEnv,pattern:RegExp)=>{const r=await cli(['restore','--backup',file],env);assert.equal(r.code,1,label+' '+r.stdout);assert.match(r.stderr,pattern,label);assert.equal(r.stdout,'',label);};
 let f=await copy('flip');const bytes=await readFile(f);bytes[Math.floor(bytes.length/2)]^=0xff;await writeFile(f,bytes);await expectRefused('one flipped byte',f,target,/checksum differs/);
 f=await copy('trunc');await writeFile(f,(await readFile(f)).subarray(0,2000));await expectRefused('truncated',f,target,/size differs/);
 f=await copy('manifest-sha');let m=JSON.parse(await text(f.replace(/\.dump$/,'.manifest.json')));m.sha256='0'.repeat(64);await writeFile(f.replace(/\.dump$/,'.manifest.json'),JSON.stringify(m));await expectRefused('manifest checksum edited',f,target,/checksum differs/);
 f=await copy('manifest-kind');m.kind='other';await writeFile(f.replace(/\.dump$/,'.manifest.json'),JSON.stringify(m));await expectRefused('manifest of another kind',f,target,/manifest is not valid/);
 f=await copy('nomanifest');await rm(f.replace(/\.dump$/,'.manifest.json'));await expectRefused('manifest missing',f,target,/manifest is missing/);
 f=await copy('renamed');const renamed=join(dir,'renamed','other-name.dump');await copyFile(f,renamed);await copyFile(f.replace(/\.dump$/,'.manifest.json'),renamed.replace(/\.dump$/,'.manifest.json'));await expectRefused('file renamed away from its manifest',renamed,target,/manifest is not valid/);
 await expectRefused('not a .dump file',join(dir,'flip',base+'.manifest.json'),target,/must end in \.dump/);
 await expectRefused('target is the live database',backupFile,dbEnv('hw_r7_live'),/ends in _restore/);
 await expectRefused('source database as target',backupFile,dbEnv('hw_r7_source'),/ends in _restore/);
 await expectRefused('application role',backupFile,dbEnv('hw_r7_second_restore','health_wallet_app'),/not the application role/);
 await expectRefused('target already has data',backupFile,dbEnv('hw_r7_target_restore'),/not empty/);
 assert.ok(await empty('hw_r7_second_restore'),'nothing was written by any refused attempt');
 await owner.query('ALTER ROLE health_wallet_migrator RENAME TO hw_r7_renamed');try{await expectRefused('required role missing',backupFile,target,/required roles are missing in the target: health_wallet_migrator/);}finally{await owner.query('ALTER ROLE hw_r7_renamed RENAME TO health_wallet_migrator');}
 assert.ok(await empty('hw_r7_second_restore'));
 // a restore that cannot finish leaves nothing half-built
 await owner.query("CREATE ROLE hw_r7_limited LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE");await owner.query('ALTER DATABASE hw_r7_second_restore OWNER TO hw_r7_limited');await owner.query('GRANT ALL ON SCHEMA public TO hw_r7_limited');
 const failed=await cli(['restore','--backup',backupFile],dbEnv('hw_r7_second_restore','hw_r7_limited'));
 if(failed.code!==0){assert.match(failed.stderr,/^Refused: pg_restore failed\./);assert.ok(await empty('hw_r7_second_restore'),'single-transaction restore: a failure leaves the target empty');}
 await owner.query('REASSIGN OWNED BY hw_r7_limited TO CURRENT_USER');await owner.query('DROP OWNED BY hw_r7_limited');await owner.query('DROP ROLE hw_r7_limited');
 // a good restore into the second target proves the same backup is reusable (repeatable drill)
 const again=await cli(['restore','--backup',backupFile],target);assert.equal(again.code,0,again.stderr+again.stdout);assert.equal(JSON.parse(again.stdout).ok,true);
 await rm(dir,{recursive:true,force:true});
});

test('R7-10 recovery tooling stays inside its limits: no password handling, no destructive commands, no network, no cloud calls',async()=>{
 const src=await text(recovery);
 assert.ok(!/PASSWORD|--password|-W\b/.test(src.replace(/Connection settings are[^\n]*\n[^\n]*\n[^\n]*\n/,'')),'no password option or variable in the tool');
 assert.ok(!/DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE|--clean|--create|rm\(|unlink|rmSync/i.test(src),'the tool never drops, cleans or deletes anything');
 assert.ok(!/fetch\(|https?:\/\/|aws |@aws-sdk|s3:/i.test(src.replace(/\/\/ .*/g,'')),'no network or cloud calls: uploading to the private bucket is a separate, owner-approved step');
 assert.match(src,/--single-transaction/);assert.match(src,/--exit-on-error/);assert.match(src,/_restore/);assert.match(src,/REPEATABLE READ/);
 const runbook=await text(root+'docs/R7_STAGING_DEPLOYMENT_READINESS.md');
 for(const needle of ['CFG-09','RPO','RTO','owner','us-east-1','not approved','BLOCKED'])assert.ok(runbook.includes(needle),'the runbook states: '+needle);
 assert.ok(!/ap-southeast-2|402909940531/.test(runbook.replace(/older[^\n]*\n/gi,'')) || /older|earlier|previous/i.test(runbook),'the older account/region is only mentioned as a conflict');
});

// ---------------------------------------------------------------- real container builds and smoke runs
const tag=(n:string)=>'hw-staging-'+n+':r7';
const dockerTest=dockerReady?test:test.skip;
dockerTest('R7-11 the three images build from the repository, run as non-root with a read-only filesystem, and contain no secrets or test code',{timeout:3_000_000},async()=>{
 for(const [file,name] of [['backend','api'],['ai-service','ai'],['web','web']] as const){const b=await sh('docker',['build','-f',staging+file+'.Dockerfile','-t',tag(name),root],{timeout:1_500_000});assert.equal(b.code,0,file+' build failed:\n'+(b.stderr+b.stdout).slice(-1500));}
 for(const name of ['api','ai','web']){
  const inspect=JSON.parse((await sh('docker',['image','inspect',tag(name)])).stdout)[0];
  assert.ok(inspect.Config.User&&!/^(root|0)(:|$)/.test(inspect.Config.User),name+' image user: '+inspect.Config.User);
  // The official Python base image sets GPG_KEY to the public 40-hex fingerprint of the release signing key; nothing else secret-like is allowed.
  const env=(inspect.Config.Env as string[]).filter(e=>!/^GPG_KEY=[A-F0-9]{40}$/.test(e)).join('\n');assert.ok(!/(SECRET|PASSWORD|TOKEN|KEY)=/.test(env),name+': no secret in the image environment');
  const hist=(await sh('docker',['history','--no-trunc','--format','{{.CreatedBy}}',tag(name)])).stdout;assert.ok(!/(SECRET|PASSWORD|TOKEN)=\S/.test(hist),name+': no secret in the build history');
  const found=await sh('docker',['run','--rm','--entrypoint','sh',tag(name),'-c',"find / -xdev \\( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '.aws' -o -name '.private-evidence' -o -name '*.test.js' -o -name '*.test.ts' \\) -not -path '/etc/ssl*/*' -not -path '/usr/lib/ssl*/*' -not -path '/usr/share/ca-certificates/*' -not -path '/usr/lib/python3*' -not -path '*/node_modules/*' -not -path '/usr/local/lib/node_modules/*' -not -path '/usr/local/lib/python3*' 2>/dev/null | head"]);
  assert.equal(found.stdout.trim(),'',name+': unexpected files in the image:\n'+found.stdout);
 }
 const api=await sh('docker',['run','--rm','--entrypoint','sh',tag('api'),'-c','ls /app/backend/migrations | wc -l; id -u; test ! -e /app/backend/src && echo no-source; ls /app/backend/dist | head -3']);
 const lines=api.stdout.trim().split('\n');assert.equal(lines[0].trim(),'21','all migrations ship');assert.notEqual(lines[1].trim(),'0');assert.ok(api.stdout.includes('no-source'));
 const tests=await sh('docker',['run','--rm','--entrypoint','sh',tag('api'),'-c',"find /app/backend/dist \\( -name '*.test.js' -o -name '*.check.js' -o -type d -name 'phase*' -o -type d -name 'r[0-9]*' \\) | head -3"]);assert.equal(tests.stdout.trim(),'','no test code in the API image');
 const ai=await sh('docker',['run','--rm','--entrypoint','python',tag('ai'),'-c','import rag_service.app,summary_service.app,ocr_service.app,sys;print("imports-ok")']);assert.match(ai.stdout,/imports-ok/,ai.stderr.slice(-400));
 const tess=await sh('docker',['run','--rm','--entrypoint','sh',tag('ai'),'-c','tesseract --version | head -1; pdftoppm -v 2>&1 | head -1']);assert.match(tess.stdout,/tesseract/i);
});

dockerTest('R7-12 the staging stack starts together: secrets from files, API health, AI service on loopback only, nginx origins and routing',{timeout:900_000},async()=>{
 const net='hw-r7-net-'+randomBytes(3).toString('hex'),dir=await mkdtemp(join(tmpdir(),'hw-r7-run-')),names:string[]=[];
 await chmod(dir,0o755);const secret=async(n:string,v:string)=>{await writeFile(join(dir,n),v,{mode:0o644});};
 const jwt=randomBytes(32).toString('hex'),adminJwt=randomBytes(32).toString('hex'),ragToken=randomBytes(32).toString('hex'),dbPassword='Syn-'+randomBytes(12).toString('hex');
 await secret('jwt_secret',jwt+'\n');await secret('admin_jwt_secret',adminJwt);await secret('rag_service_token',ragToken);await secret('db_app_password',dbPassword);
 const secretValues=[jwt,adminJwt,ragToken,dbPassword];
 const hardened=['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','256','--tmpfs','/tmp:rw,noexec,nosuid,size=64m'];
 const start=async(args:string[],label:string)=>{const name='hw-r7-'+label+'-'+randomBytes(3).toString('hex');names.push(name);const r=await sh('docker',['run','-d','--name',name,...args]);assert.equal(r.code,0,label+': '+r.stderr);return name;};
 const waitHttp=async(url:string,ok=(s:number)=>s===200)=>{for(let i=0;i<60;i++){try{const r=await fetch(url,{signal:AbortSignal.timeout(2000),redirect:'manual'});if(ok(r.status))return r;}catch{}await new Promise(r=>setTimeout(r,1000));}throw Error('no answer from '+url);};
 const hostPort=async(name:string,port:number)=>(await sh('docker',['port',name,String(port)])).stdout.trim().split('\n')[0].split(':').pop()!;
 try{
  await sh('docker',['network','create',net]);
  const apiEnv=['-e','NODE_ENV=production','-e','PORT=5000','-e','TRUST_PROXY_HOPS=1','-e','DB_HOST=localhost','-e','DB_PORT=5432','-e','DB_NAME=ai_health_wallet_staging','-e','DB_USER=health_wallet_app','-e','DB_PASSWORD_FILE=/run/secrets/db_app_password','-e','JWT_SECRET_FILE=/run/secrets/jwt_secret','-e','ADMIN_JWT_SECRET_FILE=/run/secrets/admin_jwt_secret','-e','RAG_PROVIDER=synthetic-offline','-e','RAG_SERVICE_URL=http://127.0.0.1:8013/internal/v1/rag/','-e','RAG_SERVICE_TOKEN_FILE=/run/secrets/rag_service_token','-e','FRONTEND_ORIGIN=http://127.0.0.1:8080'];
  const api=await start(['--network',net,'--network-alias','api',...hardened,'-v',dir+':/run/secrets:ro','-p','127.0.0.1::5000',...apiEnv,tag('api')],'api');
  const apiUrl='http://127.0.0.1:'+await hostPort(api,5000);
  const health=await waitHttp(apiUrl+'/api/v1/health');assert.equal(health.status,200);assert.equal((await fetch(apiUrl+'/api/v1/health/db')).status,503,'no database reachable: reported as unavailable, not as a crash');
  assert.equal((await fetch(apiUrl+'/api/v1/patients/me')).status,401);assert.equal((await fetch(apiUrl+'/api/v1/admin/me')).status,401,'the admin secret was loaded from its file');
  assert.equal((await fetch(apiUrl+'/api/v1/rag/queries',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401,'RAG route exists (it is no longer an unconfigured stub)');
  const logs=(await sh('docker',['logs',api])).stdout+(await sh('docker',['logs',api])).stderr;for(const v of secretValues)assert.ok(!logs.includes(v),'no secret in the API log');
  const inspect=(await sh('docker',['inspect',api])).stdout;for(const v of secretValues)assert.ok(!inspect.includes(v),'secret values are not in the container definition');
  assert.notEqual((await sh('docker',['exec',api,'id','-u'])).stdout.trim(),'0');
  assert.notEqual((await sh('docker',['exec',api,'sh','-c','touch /app/backend/x 2>&1'])).code,0,'the code directory is not writable');assert.notEqual((await sh('docker',['exec',api,'sh','-c','touch /etc/x 2>&1'])).code,0,'read-only root filesystem');
  // AI service in the API's network namespace (as compose does): reachable on loopback from the API container only
  const ai=await start(['--network','container:'+api,...hardened,'-v',dir+':/run/secrets:ro','-e','RAG_PROVIDER=synthetic-offline','-e','RAG_SERVICE_PORT=8013','-e','RAG_SERVICE_TOKEN_FILE=/run/secrets/rag_service_token',tag('ai')],'rag');
  let ready=false;for(let i=0;i<60&&!ready;i++){const r=await sh('docker',['exec',api,'/usr/local/bin/load-secrets.sh','node','-e',"fetch('http://127.0.0.1:8013/health',{headers:{Authorization:'Bearer '+process.env.RAG_SERVICE_TOKEN}}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"]);ready=r.code===0;if(!ready)await new Promise(r=>setTimeout(r,1000));}
  assert.ok(ready,'the Node API reaches the AI service on 127.0.0.1 with the shared token');
  assert.equal((await sh('docker',['exec',api,'node','-e',"fetch('http://127.0.0.1:8013/health').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"])).code,0,'no token, no service');
  const aiLogs=(await sh('docker',['logs',ai])).stdout+(await sh('docker',['logs',ai])).stderr;for(const v of secretValues)assert.ok(!aiLogs.includes(v));
  assert.ok(!(await sh('docker',['port',ai])).stdout.trim(),'the AI service publishes no port');
  const bare=await sh('docker',['run','--rm',...hardened,'-e','RAG_PROVIDER=synthetic-offline',tag('ai')]);assert.notEqual(bare.code,0,'the AI service refuses to start without its token');
  const wrongProvider=await sh('docker',['run','--rm',...hardened,'-v',dir+':/run/secrets:ro','-e','RAG_PROVIDER=hosted','-e','RAG_SERVICE_TOKEN_FILE=/run/secrets/rag_service_token',tag('ai')]);assert.notEqual(wrongProvider.code,0,'a hosted provider is refused');
  // web
  const web=await start(['--network',net,...hardened.filter(x=>x!=='/tmp:rw,noexec,nosuid,size=64m'&&x!=='--tmpfs'),'--tmpfs','/tmp:rw,noexec,nosuid,size=32m','--tmpfs','/var/cache/nginx:rw,noexec,nosuid,size=32m','-p','127.0.0.1::8080','-p','127.0.0.1::8081',tag('web')],'web');
  const doctor='http://127.0.0.1:'+await hostPort(web,8080),adminOrigin='http://127.0.0.1:'+await hostPort(web,8081);
  await waitHttp(doctor+'/healthz');
  for(const [name,origin] of [['doctor',doctor],['admin',adminOrigin]] as const){
   const page=await fetch(origin+'/');assert.equal(page.status,200,name);const html=await page.text();assert.match(html,/<div id="root"/,name);
   for(const [h,v] of [['x-content-type-options','nosniff'],['x-frame-options','DENY'],['referrer-policy','no-referrer'],['cache-control','no-store']])assert.equal(page.headers.get(h),v,name+' '+h);
   assert.match(page.headers.get('content-security-policy')??'',/default-src 'self'.*frame-ancestors 'none'/,name);assert.equal(page.headers.get('server'),'nginx',name+' version not disclosed');
   assert.equal((await fetch(origin+'/some/deep/link')).status,200,name+': single-page fallback');
  }
  assert.equal((await fetch(doctor+'/api/v1/health')).status,200,'doctor origin reaches the API');assert.equal((await fetch(doctor+'/api/v1/admin/me')).status,404,'doctor origin never reaches admin routes');
  assert.equal((await fetch(adminOrigin+'/api/v1/admin/me')).status,401,'admin origin reaches admin routes (login required)');assert.equal((await fetch(adminOrigin+'/api/v1/health')).status,404,'admin origin reaches nothing else');assert.equal((await fetch(adminOrigin+'/api/v1/patients/me')).status,404);
  const big=await fetch(adminOrigin+'/api/v1/admin/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"x":"'+'a'.repeat(70000)+'"}'});assert.equal(big.status,413,'admin origin limits request bodies');
  assert.ok(!(await (await fetch(doctor+'/')).text()).includes('sourceMappingURL'),'no source maps served');
 }finally{
  for(const n of names.reverse())await sh('docker',['rm','-f',n]);await sh('docker',['network','rm',net]);await rm(dir,{recursive:true,force:true});
 }
});
