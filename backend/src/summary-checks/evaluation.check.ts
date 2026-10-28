import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
interface Outcome {case:string;scenario:string;accepted:boolean;expected_acceptance:boolean;expectation_met:boolean;grounding_valid:boolean;semantic_valid:boolean;}
interface Receipt {schema_version:number;fixture_set_sha256:string;evaluator_sha256:string;summary:{scenarios:number;expectations_met:number;accepted:number;passed:boolean};outcomes:Outcome[];}
function run(){
 const dir=mkdtempSync(join(tmpdir(),'hw-offline-evaluation-'));
 try{
  const p=spawnSync('python3',['-m','summary_evaluation.runner','--receipt',join(dir,'receipt.json')],{cwd:root,env:{PATH:process.env.PATH,PYTHONPATH:join(root,'ai-service'),PYTHONDONTWRITEBYTECODE:'1',HOME:dir},timeout:15000,maxBuffer:65536,encoding:'utf8'});
  assert.ok(p.status===0,'Offline evaluation command failed');
  assert.ok(statSync(join(dir,'receipt.json')).mode%512===0o600,'Receipt must be private');
  return JSON.parse(readFileSync(join(dir,'receipt.json'),'utf8')) as Receipt;
 }finally{rmSync(dir,{recursive:true,force:true});}
}
const receipt=run();
test('offline evaluation command has reproducible machine-readable results',()=>assert.deepEqual(run(),receipt));
test('independent gold expectations are met',()=>{assert.equal(receipt.summary.scenarios,42);assert.equal(receipt.summary.expectations_met,42);assert.equal(receipt.summary.accepted,11);assert.ok(receipt.summary.passed);});
test('grounding does not conceal a missing critical catalogue fact',()=>{const r=receipt.outcomes.find(r=>r.scenario==='catalogue_gap')!;assert.ok(r.grounding_valid);assert.equal(r.semantic_valid,false);assert.equal(r.accepted,false);});
test('receipt binds fixture and evaluator fingerprints',()=>{assert.equal(receipt.schema_version,1);for(const h of [receipt.evaluator_sha256,receipt.fixture_set_sha256])assert.match(h,/^[a-f0-9]{64}$/);});
test('evaluation has no production startup integration',()=>{
 for(const file of ['backend/src/app.ts','backend/src/summaries/executor-entry.ts','backend/src/processing/background-entry.ts']){
  const source=readFileSync(join(root,file),'utf8');assert.ok(!source.includes('summary_evaluation'),'Evaluation must remain explicit and offline');
 }
});
