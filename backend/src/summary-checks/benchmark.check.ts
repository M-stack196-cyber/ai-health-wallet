import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
interface Manifest {schema_version:number;mode:string;external_execution_enabled:boolean;candidate_model:null;provider_allowlist:unknown[];fixture_set_sha256:string;preparation_sha256:string;limits:{concurrency:number;max_requests:number;spending_cap_microusd:number};requests:{case:string;input_sha256:string}[];gates:Record<string,boolean>;}
function prepare(){
 const dir=mkdtempSync(join(tmpdir(),'hw-benchmark-preparation-'));
 try{
  const p=spawnSync('python3',['-m','summary_benchmark.preparation','--manifest',join(dir,'manifest.json')],{cwd:root,env:{PATH:process.env.PATH,HOME:dir,PYTHONPATH:join(root,'ai-service'),PYTHONDONTWRITEBYTECODE:'1'},timeout:15000,maxBuffer:65536,encoding:'utf8'});
  assert.ok(p.status===0,'Benchmark preparation refused');assert.equal(statSync(join(dir,'manifest.json')).mode%512,0o600);
  return JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8')) as Manifest;
 }finally{rmSync(dir,{recursive:true,force:true});}
}
const manifest=prepare();
test('benchmark dry-run manifest is reproducible',()=>assert.deepEqual(prepare(),manifest));
test('benchmark is disabled with no selected real model or provider',()=>{assert.equal(manifest.mode,'dry-run');assert.equal(manifest.external_execution_enabled,false);assert.equal(manifest.candidate_model,null);assert.equal(manifest.provider_allowlist.length,0);assert.ok(Object.values(manifest.gates).every(v=>v===false));});
test('held-out requests have pinned distinct fingerprints and bounded resources',()=>{assert.equal(manifest.requests.length,12);assert.equal(new Set(manifest.requests.map(r=>r.input_sha256)).size,12);assert.equal(manifest.limits.concurrency,1);assert.equal(manifest.limits.max_requests,12);assert.equal(manifest.limits.spending_cap_microusd,1000000);for(const h of [manifest.fixture_set_sha256,manifest.preparation_sha256])assert.match(h,/^[a-f0-9]{64}$/);});
test('no application startup imports benchmark preparation',()=>{
 for(const f of ['backend/src/app.ts','backend/src/summaries/executor-entry.ts','backend/src/processing/background-entry.ts'])assert.ok(!readFileSync(join(root,f),'utf8').includes('summary_benchmark'));
});
test('no live flag is accepted by preparation CLI',()=>{
 const p=spawnSync('python3',['-m','summary_benchmark.preparation','--run'],{cwd:root,env:{PATH:process.env.PATH,PYTHONPATH:join(root,'ai-service'),PYTHONDONTWRITEBYTECODE:'1'},timeout:15000,encoding:'utf8'});assert.equal(p.status,2);
});
