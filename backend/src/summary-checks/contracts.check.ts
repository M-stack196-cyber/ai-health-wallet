import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {SCHEMA,GLOSSARY} from '../summaries/schema.generated.js';
import {validateSummaryInput,validateSummaryOutput,validateSummaryStructure,summaryInputDigest,renderSummary,parseSummaryJson,SummaryValidationError} from '../summaries/validation.js';
import type {SummaryInputV1,SummaryOutputV1,SummaryValidationContext,SummaryProvenanceV1} from '../summaries/contracts.js';
interface Case {id:string;expected:string;input:SummaryInputV1;output:SummaryOutputV1;context:SummaryValidationContext;recipe:SummaryProvenanceV1;expected_render_sha256?:string;}
const fixtureUrl=new URL('../../../shared/medical-summary/fixtures.json',import.meta.url);
const cases=(JSON.parse(await readFile(fixtureUrl,'utf8')) as {cases:Case[]}).cases;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function run(c:Case){let code='OK',render:string|null=null;try{validateSummaryOutput(c.output,c.input,c.context,c.recipe);render=renderSummary(c.output,c.input,c.context,c.recipe);}catch(e){code=e instanceof SummaryValidationError?e.code:'UNEXPECTED_ERROR';}return {code,render};}
for(const c of cases)test('summary contract fixture '+c.id,()=>{
  const result=run(c);assert.equal(result.code,c.expected,c.id);
  if(c.expected==='OK'){assert.ok(result.render!==null&&result.render.length>0,'Expected accepted plain text');if(c.expected_render_sha256)assert.ok(hash(result.render!)===c.expected_render_sha256,'Golden rendering changed');}
});
const wires:Record<string,string>={truncated:'{"schema_version":',duplicate:'{"a":1,"a":2}',escaped_duplicate:'{"a":1,"\\u0061":2}',float:'{"a":1.0}',exponent:'{"a":1e2}',nan:'{"a":NaN}',infinity:'{"a":Infinity}',trailing:'{"a":1,}',trailing_array:'[1,]',trailing_content:'{} {}',unsafe_integer:'9007199254740992',deep:'['.repeat(25)+'0'+']'.repeat(25),invalid_surrogate:'"\\ud800"',control:'"\\u0000"'};
for(const [id,wire]of Object.entries(wires))test('strict JSON wire refusal '+id,()=>{
  let error:unknown;try{parseSummaryJson(Buffer.from(wire),'input');}catch(e){error=e;}assert.ok(error instanceof SummaryValidationError,'Expected redacted failure');
});
test('malformed UTF-8 fails safely',()=>{assert.throws(()=>parseSummaryJson(new Uint8Array([255]),'input'),SummaryValidationError);});
test('wire size limit is enforced',()=>{assert.throws(()=>parseSummaryJson(new Uint8Array(262145),'input'),SummaryValidationError);});
test('valid input wire roundtrip preserves UTF-8 source digest',()=>{const c=cases[0];const value=parseSummaryJson(Buffer.from(JSON.stringify(c.input)),'input');assert.ok(summaryInputDigest(value)===c.context.input_sha256);validateSummaryInput(value,c.context);});
test('reordering output cannot change rendered meaning or order',()=>{const c=clone(cases.find(c=>c.id==='conflict')!);const original=renderSummary(c.output,c.input,c.context,c.recipe);c.output.reported_findings.reverse();assert.ok(renderSummary(c.output,c.input,c.context,c.recipe)===original,'Rendering must be deterministic');});
test('renderer validates again after source mutation',()=>{const c=clone(cases[0]);validateSummaryOutput(c.output,c.input,c.context,c.recipe);c.input.source.text+=' modified';assert.throws(()=>renderSummary(c.output,c.input,c.context,c.recipe),SummaryValidationError);});
test('error representations disclose no source text or scope identifiers',()=>{
  const c=clone(cases[0]);c.output.scope.scope_token='e'.repeat(64);let error:unknown;try{renderSummary(c.output,c.input,c.context,c.recipe);}catch(e){error=e;}
  assert.ok(error instanceof SummaryValidationError);const text=String(error)+' '+JSON.stringify(error);assert.ok([c.input.source.text,...Object.values(c.input.scope)].every(value=>!text.includes(value)),'Unsafe validation error');assert.ok(!Object.hasOwn(error,'cause'));
});
test('schema and glossary are immutable at runtime',()=>{assert.ok(Object.isFrozen(SCHEMA.$defs.Fact.properties)&&Object.isFrozen(GLOSSARY.entries.glucose));});
test('API routes stay disconnected from summary execution; OCR and Stage C stay separate',async()=>{
  for(const name of ['server.ts','processing/background-entry.ts','stage-c/live-runtime.ts'])assert.doesNotMatch(await readFile(new URL('../'+name,import.meta.url),'utf8'),/summaries\/|summary_contracts/);
  const app=await readFile(new URL('../app.ts',import.meta.url),'utf8');assert.match(app,/createSummaryRoutes/);
  for(const source of [app,await readFile(new URL('../summaries/routes.ts',import.meta.url),'utf8')])
    assert.doesNotMatch(source,/executor(?:-entry)?\.js|createSummaryExecutor|launchSummaryExecutor|\.runOnce\(|\.start\(/);
});
test('Python and TypeScript agree on schemas, outcomes, fingerprints and renderings',async()=>{
  const script=fileURLToPath(new URL('../../../ai-service/tools/check_contracts.py',import.meta.url));
  const {stdout}=await promisify(execFile)('python3',[script],{timeout:15000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'}});
  const python=JSON.parse(stdout) as {id:string;code:string;render_sha256:string|null;input_sha256:string|null;input_structure:boolean;output_structure:boolean}[];
  assert.equal(python.length,cases.length);
  for(const c of cases){const p=python.find(r=>r.id===c.id)!;const r=run(c);let inputHash:string|null=null;try{inputHash=summaryInputDigest(c.input);}catch{}
    assert.ok(p&&p.code===r.code&&p.render_sha256===(r.render===null?null:hash(r.render))&&p.input_sha256===inputHash&&p.input_structure===validateSummaryStructure('SummaryInputV1',c.input)&&p.output_structure===validateSummaryStructure('SummaryOutputV1',c.output),'Cross-language contract mismatch: '+c.id);}
});
