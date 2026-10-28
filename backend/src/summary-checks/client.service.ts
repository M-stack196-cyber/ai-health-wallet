import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createSummaryClient, fakeSummaryRecipe, summaryServicePath, SummaryClientError, type SummaryTransport, type SummaryTransportRequest} from '../summaries/client.js';
import {canonicalSummaryJson, renderSummary} from '../summaries/validation.js';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const cases=JSON.parse(readFileSync(root+'shared/medical-summary/fixtures.json','utf8')).cases;
const base=cases.find((c:any)=>c.expected==='OK');
const token='a'.repeat(64);
const response=()=>({...structuredClone(base.output),provenance:fakeSummaryRecipe(base.context.input_sha256)});
const bytes=(v:unknown)=>Buffer.from(canonicalSummaryJson(v));
async function* body(v:unknown){yield bytes(v);}
const okay:SummaryTransport=async()=>({status:200,body:body(response())});
const client=(transport:SummaryTransport=okay,extra={})=>createSummaryClient({enabled:true,token,...extra},transport);
async function refusal(fn:()=>unknown,code:string){
  let got:unknown;try{await fn();}catch(e){got=e;}
  assert.equal(got instanceof SummaryClientError,true);
  assert.equal((got as SummaryClientError)?.code,code);
  assert.equal(String(got).includes(token),false);
}
test('client defaults disabled without transport',()=>refusal(()=>createSummaryClient().generate(base.input,base.context),'CLIENT_DISABLED'));
test('client refuses absent transport',()=>assert.throws(()=>createSummaryClient({enabled:true,token}),/^SummaryClientError: Summary client refused: INVALID_CLIENT_CONFIG$/));
test('client refuses invalid configuration without disclosing values',()=>{
  for(const x of [{token:'JWT.SYNTHETIC.SECRET'},{timeoutMs:0},{timeoutMs:10001},{concurrency:0},{concurrency:5},{enabled:'true'},{unexpected:'secret'}]){
    assert.throws(()=>client(okay,x),/^SummaryClientError: Summary client refused: INVALID_CLIENT_CONFIG$/);
  }
});
test('client sends exact endpoint, independent context and synthetic service auth',async()=>{
  let verified=false;
  const c=client(async r=>{
    verified=r.path===summaryServicePath&&r.method==='POST'&&r.headers.authorization==='Bearer '+token&&r.headers['x-summary-input-sha256']===base.context.input_sha256&&r.maxResponseBytes===131072;
    return okay(r);
  });
  const out=await c.generate(base.input,base.context);assert.equal(verified,true);assert.equal(canonicalSummaryJson(out)===canonicalSummaryJson(response()),true);
});
test('client deterministic output reuses renderer',async()=>{
  const c=client(),a=await c.generate(base.input,base.context),b=await c.generate(base.input,base.context);
  assert.equal(canonicalSummaryJson(a)===canonicalSummaryJson(b),true);
  assert.equal(renderSummary(a,base.input,base.context,fakeSummaryRecipe(base.context.input_sha256))===renderSummary(b,base.input,base.context,fakeSummaryRecipe(base.context.input_sha256)),true);
});
for(const field of ['patient_id','jwt','s3_object_key','source_path','job_state'])test('client rejects unsupported '+field,()=>refusal(()=>client().generate({...base.input,[field]:'synthetic'},base.context),'INVALID_REQUEST'));
test('client rejects unexpected context metadata',()=>refusal(()=>client().generate(base.input,{...base.context,patient_id:'synthetic'}),'INVALID_REQUEST'));
test('client rejects cross-patient context before transport',async()=>{
  let calls=0;await refusal(()=>client(async r=>{calls++;return okay(r);}).generate(base.input,{...base.context,scope_token:'b'.repeat(64)}),'INVALID_REQUEST');assert.equal(calls,0);
});
for(const change of ['quote','decimal','range','page','source','scope','provenance','advice'])test('client rejects candidate '+change,async()=>{
  const out=response();const f=out.reported_findings[0];
  if(change==='quote')f.evidence.quote='unsupported synthetic text';
  if(change==='decimal')f.measurement.value.decimal='999.99';
  if(change==='range')f.measurement.reported_range={text:'invented',evidence:f.evidence};
  if(change==='page')f.evidence.page=1;
  if(change==='source')f.evidence.source_ref='00000000-0000-4000-8000-000000000001';
  if(change==='scope')out.scope.scope_token='b'.repeat(64);
  if(change==='provenance')out.provenance.model_revision='2';
  if(change==='advice')out.treatment_change='synthetic advice';
  await refusal(()=>client(async()=>({status:200,body:body(out)})).generate(base.input,base.context),'INVALID_RESPONSE');
});
test('client redacts transport errors and never retries',async()=>{
  let calls=0;await refusal(()=>client(async()=>{calls++;throw new Error('SYNTHETIC_SECRET_SENTINEL');}).generate(base.input,base.context),'REMOTE_FAILURE');assert.equal(calls,1);
});
test('client does not parse or echo remote failures',()=>refusal(()=>client(async()=>({status:401,body:body('SYNTHETIC_SECRET_SENTINEL')})).generate(base.input,base.context),'REMOTE_FAILURE'));
test('client rejects malformed JSON',()=>refusal(()=>client(async()=>({status:200,body:(async function*(){yield Buffer.from('{');})()})).generate(base.input,base.context),'INVALID_RESPONSE'));
test('client rejects duplicate JSON keys',()=>refusal(()=>client(async()=>({status:200,body:(async function*(){yield Buffer.from('{"schema_version":1,"schema_version":1}');})()})).generate(base.input,base.context),'INVALID_RESPONSE'));
test('client bounds response bytes',()=>refusal(()=>client(async()=>({status:200,body:(async function*(){yield Buffer.alloc(131073);})()})).generate(base.input,base.context),'INVALID_RESPONSE'));
test('client bounds empty response chunks',()=>refusal(()=>client(async()=>({status:200,body:(async function*(){for(let i=0;i<10001;i++)yield new Uint8Array();})()})).generate(base.input,base.context),'INVALID_RESPONSE'));
test('client cancellation before admission never calls transport',async()=>{
  let calls=0;const abort=new AbortController();abort.abort();await refusal(()=>client(async r=>{calls++;return okay(r);}).generate(base.input,base.context,abort.signal),'CANCELLED');assert.equal(calls,0);
});
const untilAbort:SummaryTransport=r=>new Promise((_resolve,reject)=>r.signal.addEventListener('abort',()=>reject(new Error('SYNTHETIC_CANCELLED')),{once:true}));
test('client deadline aborts injected transport',()=>refusal(()=>client(untilAbort,{timeoutMs:30}).generate(base.input,base.context),'DEADLINE_EXCEEDED'));
test('client caller cancellation aborts transport',async()=>{
  const abort=new AbortController();const pending=refusal(()=>client(untilAbort).generate(base.input,base.context,abort.signal),'CANCELLED');abort.abort();await pending;
});
test('client has bounded admission without a queue',async()=>{
  let release!:(x:any)=>void;const c=client(()=>new Promise(resolve=>release=resolve));const one=c.generate(base.input,base.context);
  await refusal(()=>c.generate(base.input,base.context),'BUSY');release({status:200,body:body(response())});await one;
});
test('client retains capacity for uncooperative timed-out I/O',async()=>{
  let release!:(x:any)=>void;const c=client(()=>new Promise(resolve=>release=resolve),{timeoutMs:30});
  await refusal(()=>c.generate(base.input,base.context),'DEADLINE_EXCEEDED');await refusal(()=>c.generate(base.input,base.context),'BUSY');
  release({status:200,body:body(response())});await new Promise(resolve=>setTimeout(resolve,5));
});
test('client protects source snapshot from transport mutation',async()=>{
  const original=structuredClone(base.input);const context=structuredClone(base.context);
  const c=client(async r=>{original.source.text='SYNTHETIC_MUTATION';context.scope_token='b'.repeat(64);r.body.fill(0);return okay(r);});
  assert.equal((await c.generate(original,context)).schema_version,1);
});

// Runs FastAPI through HTTPX ASGITransport in a child interpreter: no TCP listener.
function bridge(request:SummaryTransportRequest):ReturnType<SummaryTransport>{
  return new Promise((resolve,reject)=>{
    const child=spawn(process.env.SUMMARY_TEST_PYTHON??'python3',[root+'ai-service/tools/service_fixture_bridge.py'],{stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    const chunks:Buffer[]=[];let n=0;const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('BRIDGE_TIMEOUT'));},5000);
    child.stdout.on('data',(x:Buffer)=>{if((n+=x.length)>262144){child.kill('SIGTERM');reject(new Error('BRIDGE_SIZE'));}else chunks.push(x);});
    child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(new Error('BRIDGE_FAILURE'));});
    child.on('close',code=>{clearTimeout(timer);if(code!==0){reject(new Error('BRIDGE_FAILURE'));return;}
      try{const r=JSON.parse(Buffer.concat(chunks).toString());resolve({status:r.status,body:(async function*(){yield Buffer.from(r.body);})()});}catch{reject(new Error('BRIDGE_FAILURE'));}
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({headers:request.headers,body:Buffer.from(request.body).toString()}));
  });
}
test('mocked Node client and in-process FastAPI agree on all golden fixtures',async()=>{
  for(const fixture of cases.filter((c:any)=>c.expected==='OK')){
    const out=await client(bridge,{timeoutMs:5000}).generate(fixture.input,fixture.context);
    assert.equal(out.schema_version,1);assert.equal(out.provenance.provider,'synthetic-fake');
  }
});
