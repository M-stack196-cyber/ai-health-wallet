import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {inspect} from 'node:util';
import {mkdtemp,mkdir,writeFile,chmod,rm,symlink,rename,readFile,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {credentialSha256,nodeCredentialFileSystem,CredentialFileError,type CredentialFileSystem,type CredentialHandle,type FileIdentity} from '../stage-c/credential-files.js';
import {loadSystemFileCredentials,selectCredentialLoading,credentialDeploymentIdentity,type SystemFileSelection} from '../stage-c/system-credentials.js';
import {systemUnitDefinition,type SystemPlan,artifactRoles} from '../stage-c/system-supervision.js';
import {target} from '../integration/guards.js';
const patient='00000000-0000-4000-8000-000000000001',cutoff='2026-10-22T12:00:00.000Z';
function plan():SystemPlan {
  const root='/opt/ai-health-wallet/releases/synthetic',paths={node:'/bin/node',worker:'/backend/dist/processing/background-entry.js',controller:'/backend/dist/stage-c/cli.js',inside:'/backend/dist/stage-c/inside-entry.js',adapter:'/backend/dist/stage-c/system-supervision.js',manifest:'/deployment-manifest.json'};
  return {manager:'system',run:'stage-c-'+'f'.repeat(24),bootId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',controllerInvocationId:'a'.repeat(32),controllerArguments:[],releaseDirectory:root,
    artifacts:Object.fromEntries(artifactRoles.map((k,i)=>[k,{path:root+paths[k],sha256:String(i+1).repeat(64)}])) as SystemPlan['artifacts']};
}
type Role='aws'|'postgres'|'approval';
async function fixture(readOnly=false){
  const base=await mkdtemp(join(tmpdir(),'hw-credential-offline-'));await chmod(base,0o700);
  const p=plan(),directory=join(base,systemUnitDefinition(p).name);await mkdir(directory,{mode:0o700});
  const common={version:1,run:p.run,deploymentSha256:credentialDeploymentIdentity(p)};
  const aws={...common,kind:'health-wallet-aws-profile',profile:target.profile,account:target.account,region:target.region,bucket:target.bucket,prefix:target.prefix,
    accessKeyId:randomBytes(16).toString('hex').toUpperCase(),secretAccessKey:randomBytes(48).toString('base64'),sessionToken:randomBytes(48).toString('base64')};
  const postgres={...common,kind:'health-wallet-postgres-password',host:'127.0.0.1',port:5433,database:'ai_health_wallet',user:'health_wallet_app',password:randomBytes(32).toString('base64url')};
  const approval={...common,version:2,kind:'health-wallet-processing-approval',mode:'canary',profile:target.profile,account:target.account,region:target.region,bucket:target.bucket,prefix:target.prefix,patientId:patient,uploadCutoff:cutoff};
  const names={aws:'aws-profile.json',postgres:'postgres-password.json',approval:'processing-approval.json'};
  const paths=Object.fromEntries(Object.entries(names).map(([k,v])=>[k,join(directory,v)])) as Record<Role,string>;
  const data:Record<Role,Record<string,unknown>>={aws,postgres,approval};
  const selection:SystemFileSelection={mode:'system-files',binding:{plan:p,canary:{patientId:patient,uploadCutoff:cutoff}},directory:{path:directory,ownerUid:process.getuid!(),mode:readOnly?0o500:0o700},pins:{} as SystemFileSelection['pins']};
  for(const role of ['aws','postgres','approval'] as const){const b=Buffer.from(JSON.stringify(data[role]));await writeFile(paths[role],b,{mode:0o600});if(readOnly)await chmod(paths[role],0o400);selection.pins[role]={sha256:credentialSha256(b),ownerUid:process.getuid!(),mode:readOnly?0o400:0o600};}
  if(readOnly)await chmod(directory,0o500);
  return {base,paths,data,selection,fs:nodeCredentialFileSystem(),secrets:[aws.accessKeyId,aws.secretAccessKey,aws.sessionToken,postgres.password],
    async update(role:Role,value:Record<string,unknown>|string|Uint8Array){
      const bytes=typeof value==='string'?Buffer.from(value):value instanceof Uint8Array?Buffer.from(value):Buffer.from(JSON.stringify(value));
      await chmod(paths[role],0o600);await writeFile(paths[role],bytes);await chmod(paths[role],selection.pins[role].mode);selection.pins[role].sha256=credentialSha256(bytes);
    },
    async close(){await chmod(directory,0o700);await rm(base,{recursive:true,force:true});}
  };
}
// Port wrapping makes races/ownership conditions deterministic without root,
// service operations, network connections or touching any real credential file.
function intercept(fs:CredentialFileSystem,edit:(path:string,s:FileIdentity)=>FileIdentity,onRead?:(path:string,bytes:Uint8Array)=>Promise<Uint8Array>):CredentialFileSystem {
  const wrap=(h:CredentialHandle,path:string):CredentialHandle=>({stat:async()=>edit(path,await h.stat()),
    child:async(name,kind)=>wrap(await h.child(name,kind),join(path,name)),read:async max=>{const b=await h.read(max);return onRead?onRead(path,b):b;},close:()=>h.close()});
  return {root:async()=>wrap(await fs.root(),'/'),lstat:async path=>edit(path,await fs.lstat(path))};
}
async function refused(work:Promise<unknown>,secrets:string[]=[]){
  let error:unknown;try{await work;}catch(e){error=e;}
  assert.ok(error instanceof CredentialFileError,'Expected a redacted credential refusal');
  const rendered=String(error)+' '+inspect(error)+' '+JSON.stringify(error);
  assert.ok(secrets.every(secret=>!rendered.includes(secret)),'Credential refusal must be redacted');
}
test('valid synthetic file credentials produce explicit SDK identity and PostgreSQL options',async()=>{
  const f=await fixture();try{const b=await loadSystemFileCredentials(f.selection,f.fs),a=await b.awsCredentials(),p=await b.databaseOptions();
    assert.ok(a.accessKeyId===f.data.aws.accessKeyId&&a.secretAccessKey===f.data.aws.secretAccessKey&&a.sessionToken===f.data.aws.sessionToken,'Synthetic AWS values must match');
    assert.ok(p.password===f.data.postgres.password,'Synthetic PG value must match');assert.equal(p.user,'health_wallet_app');assert.equal(p.host,'127.0.0.1');assert.equal(p.port,5433);await b.assertUnchanged();
  }finally{await f.close();}
});
test('explicit read-only credential copy policy works with 0500 directory and 0400 files',async()=>{const f=await fixture(true);try{await (await loadSystemFileCredentials(f.selection,f.fs)).assertUnchanged();}finally{await f.close();}});
test('developer default delegates unchanged to injected developer loader without filesystem',async()=>{
  const value={synthetic:true};let calls=0;const developer=async()=>{calls++;return value;};assert.equal(await selectCredentialLoading(undefined,{developer}),value);assert.equal(await selectCredentialLoading({mode:'developer'},{developer}),value);assert.equal(calls,2);
});
test('file mode failure cannot invoke developer or environment fallback',async()=>{
  const f=await fixture();let calls=0;try{await rm(f.paths.aws);await refused(selectCredentialLoading(f.selection,{files:f.fs,developer:async()=>{calls++;return {};}}));assert.equal(calls,0);}finally{await f.close();}
});
test('missing explicit file-mode selection is refused instead of developer fallback',async()=>{const f=await fixture();let called=false;try{const bad={...f.selection};delete (bad as Partial<SystemFileSelection>).mode;await refused(selectCredentialLoading(bad,{files:f.fs,developer:async()=>{called=true;return {};}}));assert.equal(called,false);}finally{await f.close();}});
test('unknown credential mode never dispatches a developer loader',async()=>{let called=false;await refused(selectCredentialLoading({mode:'automatic'} as unknown as {mode:'developer'},{developer:async()=>{called=true;return {};}}));assert.equal(called,false);});
for(const [field,value]of Object.entries({profile:'default',account:'000000000000',region:'us-east-1',bucket:'unrelated',prefix:'other/'}))test('AWS exact target refuses '+field,async()=>{const f=await fixture();try{await f.update('aws',{...f.data.aws,[field]:value});await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const field of ['source_profile','credential_process','role_arn','web_identity_token_file','endpoint_url'])test('AWS configuration rejects delegation or override '+field,async()=>{const f=await fixture();try{await f.update('aws',{...f.data.aws,[field]:'not-permitted'});await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const role of ['aws','postgres','approval'] as const)test('missing credential file refuses '+role,async()=>{const f=await fixture();try{await rm(f.paths[role]);await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const role of ['aws','postgres','approval'] as const)test('incorrect file permissions refuse '+role,async()=>{const f=await fixture();try{await chmod(f.paths[role],0o644);await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const role of ['aws','postgres','approval'] as const)test('unexpected file owner refuses '+role,async()=>{const f=await fixture();try{const fs=intercept(f.fs,(p,s)=>p===f.paths[role]?{...s,uid:s.uid+1}:s);await refused(loadSystemFileCredentials(f.selection,fs),f.secrets);}finally{await f.close();}});
for(const role of ['aws','postgres','approval'] as const)test('leaf symlink refuses '+role,async()=>{const f=await fixture();try{await rename(f.paths[role],f.paths[role]+'.saved');await symlink(f.paths[role]+'.saved',f.paths[role]);await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
test('symlinked credential-directory ancestor is refused',async()=>{const f=await fixture();try{const alias=f.base+'-alias';await symlink(f.base,alias);try{f.selection.directory.path=join(alias,systemUnitDefinition(f.selection.binding.plan).name);await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await rm(alias);}}finally{await f.close();}});
for(const field of ['permissions','owner'] as const)test('unsafe credential directory refuses '+field,async()=>{const f=await fixture();try{if(field==='permissions')await chmod(f.selection.directory.path,0o755);else f.selection.directory.ownerUid++;await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
test('unexpected regular-file hardlink count refuses credentials',async()=>{const f=await fixture();try{await link(f.paths.aws,f.paths.aws+'.copy');await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
test('unexpected credential file type is rejected before reading contents',async()=>{const f=await fixture();try{await rm(f.paths.aws);await mkdir(f.paths.aws,{mode:0o700});await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const role of ['aws','postgres','approval'] as const)test('independent SHA-256 mismatch refuses '+role,async()=>{const f=await fixture();try{f.selection.pins[role].sha256='0'.repeat(64);await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const role of ['aws','postgres','approval'] as const)test('run binding refuses '+role,async()=>{const f=await fixture();try{await f.update(role,{...f.data[role],run:'stage-c-'+'e'.repeat(24)});await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const role of ['aws','postgres','approval'] as const)test('deployment binding refuses '+role,async()=>{const f=await fixture();try{await f.update(role,{...f.data[role],deploymentSha256:'e'.repeat(64)});await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const [name,value]of Object.entries({owner:'00000000-0000-4000-8000-000000000002',cutoff:'2026-10-22T13:00:00.000Z',mode:'global',version:1}))test('approval refuses changed '+name,async()=>{const f=await fixture();try{const field=name==='owner'?'patientId':name==='cutoff'?'uploadCutoff':name;await f.update('approval',{...f.data.approval,[field]:value});await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const [field,value]of Object.entries({user:'health_wallet_migrator',host:'remote.invalid',port:5432,database:'postgres'}))test('PostgreSQL restricted target refuses '+field,async()=>{const f=await fixture();try{await f.update('postgres',{...f.data.postgres,[field]:value});await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
for(const [name,make]of Object.entries({broken:():string=>'{"private":',nested:():string=>'{"private":{}}',array:():string=>'[]',duplicate:():string=>'{"version":1,"version":1}',escapedDuplicate:():string=>'{"version":1,"\\u0076ersion":1}',trailing:():string=>'{"version":1,}',invalidUtf8:():Uint8Array=>new Uint8Array([0xff,0xfe]),empty:():string=>'',oversized:():string=>'x'.repeat(20000)}))test('malformed synthetic credential file refuses '+name,async()=>{const f=await fixture();try{await f.update('aws',make());await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
test('missing AWS key or secret never uses another provider',async()=>{const f=await fixture();try{const v={...f.data.aws};delete v.secretAccessKey;await f.update('aws',v);await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
test('empty database password never falls back to PGPASSWORD',async()=>{const f=await fixture();try{await f.update('postgres',{...f.data.postgres,password:''});await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
test('optional session token is genuinely optional',async()=>{const f=await fixture();try{const v={...f.data.aws};delete v.sessionToken;await f.update('aws',v);assert.ok((await (await loadSystemFileCredentials(f.selection,f.fs)).awsCredentials()).sessionToken===undefined);}finally{await f.close();}});
test('changing file bytes after load permanently invalidates all secret capabilities',async()=>{const f=await fixture();try{const original=await readFile(f.paths.aws),b=await loadSystemFileCredentials(f.selection,f.fs);await f.update('aws',{...f.data.aws,accessKeyId:'X'.repeat(20)});await refused(b.awsCredentials(),f.secrets);await writeFile(f.paths.aws,original);await refused(b.databaseOptions(),f.secrets);await refused(b.assertUnchanged(),f.secrets);}finally{await f.close();}});
test('same bytes at a replacement inode are refused for a loaded bundle',async()=>{const f=await fixture();try{const b=await loadSystemFileCredentials(f.selection,f.fs),bytes=await readFile(f.paths.postgres);await rename(f.paths.postgres,f.paths.postgres+'.old');await writeFile(f.paths.postgres,bytes,{mode:0o600});await refused(b.assertUnchanged(),f.secrets);}finally{await f.close();}});
test('mutation during a file read fails before a credential capability is exposed',async()=>{const f=await fixture();try{let changed=false;const fs=intercept(f.fs,(_p,s)=>s,async(path,b)=>{if(path===f.paths.aws&&!changed){changed=true;await writeFile(path,Buffer.from('changed'));}return b;});await refused(loadSystemFileCredentials(f.selection,fs),f.secrets);}finally{await f.close();}});
test('ancestor replacement during traversal is rejected without adopting a different path',async()=>{const f=await fixture();try{let moved=false;const dir=f.selection.directory.path;const fs=intercept(f.fs,(_p,s)=>s,async(path,b)=>{if(path===f.paths.aws&&!moved){moved=true;await rename(dir,dir+'.old');await mkdir(dir,{mode:0o700});}return b;});await refused(loadSystemFileCredentials(f.selection,fs),f.secrets);}finally{await f.close();}});
test('bundle and option JSON/inspection views never contain credential values',async()=>{const f=await fixture();try{const b=await loadSystemFileCredentials(f.selection,f.fs),a=await b.awsCredentials(),p=await b.databaseOptions();for(const value of [b,a,p]){const view=JSON.stringify(value)+' '+inspect(value);assert.ok(f.secrets.every(secret=>!view.includes(secret)),'Credential serialization must be redacted');}}finally{await f.close();}});
test('underlying filesystem errors cannot expose values through error text or causes',async()=>{const f=await fixture();try{const fs={...f.fs,root:async()=>{throw Error(f.secrets.join(' '));}};await refused(loadSystemFileCredentials(f.selection,fs),f.secrets);}finally{await f.close();}});
test('caller mutation of pins and scope cannot rewrite the loaded trust root',async()=>{const f=await fixture();try{const b=await loadSystemFileCredentials(f.selection,f.fs);f.selection.binding.canary={...f.selection.binding.canary,uploadCutoff:'2027-01-01T00:00:00.000Z'};f.selection.pins.aws.sha256='0'.repeat(64);await b.assertUnchanged();}finally{await f.close();}});
test('restart uses the same fixed approval bytes/pin and rejects a new cutoff',async()=>{const f=await fixture();try{await (await loadSystemFileCredentials(f.selection,f.fs)).assertUnchanged();await (await loadSystemFileCredentials(f.selection,f.fs)).assertUnchanged();f.selection.binding.canary={...f.selection.binding.canary,uploadCutoff:'2026-10-22T14:00:00.000Z'};await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
test('concurrent credential requests are serialized and check all credential files',async()=>{const f=await fixture();try{const b=await loadSystemFileCredentials(f.selection,f.fs);await Promise.all([b.awsCredentials(),b.databaseOptions(),b.assertUnchanged()]);await rm(f.paths.approval);const results=await Promise.allSettled([b.awsCredentials(),b.databaseOptions()]);assert.ok(results.every(r=>r.status==='rejected'&&r.reason instanceof CredentialFileError));}finally{await f.close();}});
test('library has no ambient/default credential resolution or external client composition',async()=>{
  const text=await readFile(new URL('../stage-c/system-credentials.ts',import.meta.url),'utf8');assert.doesNotMatch(text,/process\.env|homedir\(|dotenv|new (?:Pool|S3Client)|execFile|spawn\(/);
  for(const source of ['../stage-c/live-runtime.ts','../processing/background-runtime.ts','../config/env.ts'])assert.doesNotMatch(await readFile(new URL(source,import.meta.url),'utf8'),/system-credentials|credential-files/);
});

test('deployment binding changes when any independently pinned executable changes',async()=>{const f=await fixture();try{f.selection.binding.plan.artifacts={...f.selection.binding.plan.artifacts,node:{...f.selection.binding.plan.artifacts.node,sha256:'e'.repeat(64)}};await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
test('unsafe metadata prevents reading any credential contents',async()=>{const f=await fixture();let reads=0;try{const fs=intercept(f.fs,(path,s)=>path===f.paths.aws?{...s,uid:s.uid+1}:s,async(_path,b)=>{reads++;return b;});await refused(loadSystemFileCredentials(f.selection,fs),f.secrets);assert.equal(reads,0);}finally{await f.close();}});
test('password control characters are refused rather than becoming configuration text',async()=>{const f=await fixture();try{await f.update('postgres',{...f.data.postgres,password:randomBytes(24).toString('hex')+'\n'});await refused(loadSystemFileCredentials(f.selection,f.fs),f.secrets);}finally{await f.close();}});
