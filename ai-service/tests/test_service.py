"""Synthetic in-process tests; network connections are forbidden."""
import asyncio
import copy
import hashlib
import hmac
import json
import logging
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch
import httpx
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ai-service'))
from summary_contracts.validation import canonical_summary_json, summary_input_digest, validate_summary_output, render_summary
from summary_service.app import create_app, ServiceConfig
from summary_service.provider import DeterministicFakeProvider
from summary_service.protocol import PATH, CONTEXT_HEADERS, expected_recipe

TOKEN='a'*64
CASES=json.loads((ROOT/'shared/medical-summary/fixtures.json').read_text())['cases']
BASE=next(c for c in CASES if c['expected']=='OK') if any(c.get('expected')=='OK' for c in CASES) else CASES[0]

def headers(c=BASE):
    return {'authorization':'Bearer '+TOKEN,'content-type':'application/json',
            **{v:c['context'][k] for k,v in CONTEXT_HEADERS.items()}}
def raw(c=BASE):return canonical_summary_json(c['input']).encode()
def enabled(provider=None, **kwargs):return create_app(ServiceConfig(enabled=True,token=TOKEN,**kwargs),provider=provider or DeterministicFakeProvider())
async def post(app, *, body=None, hs=None, method='POST', path=PATH):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
        return await client.request(method,path,content=raw() if body is None else body,headers=headers() if hs is None else hs)

class FunctionProvider:
    def __init__(self, fn):self.fn=fn;self.calls=0
    async def generate(self, source, recipe):
        self.calls+=1
        return await self.fn(source,recipe)

class ServiceTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.net=patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK_FORBIDDEN'));cls.net.start()
    @classmethod
    def tearDownClass(cls):cls.net.stop()
    async def test_default_disabled(self):
        p=FunctionProvider(None);app=create_app(provider=p)
        r=await post(app);self.assertEqual(r.status_code,503);self.assertEqual(p.calls,0)
    async def test_enabled_requires_provider_and_synthetic_token(self):
        for config in [lambda:ServiceConfig(enabled=True),lambda:ServiceConfig(enabled=True,token='jwt.secret'),lambda:ServiceConfig(concurrency=0),lambda:ServiceConfig(deadline_seconds=11),lambda:ServiceConfig(enabled='true'),lambda:ServiceConfig(concurrency=True),lambda:ServiceConfig(deadline_seconds=float('nan'))]:
            with self.assertRaisesRegex(ValueError,'^INVALID_SERVICE_CONFIG$'):config()
        with self.assertRaisesRegex(ValueError,'^INVALID_SERVICE_CONFIG$'):create_app(ServiceConfig(enabled=True,token=TOKEN))
    async def test_config_repr_redacts_token(self):self.assertNotIn(TOKEN,repr(ServiceConfig(enabled=True,token=TOKEN)))
    async def test_only_endpoint_and_no_docs(self):
        app=enabled();self.assertEqual(len(app.routes),1)
        for path in ['/docs','/redoc','/openapi.json','/health','/internal/v1/report-summaries:generate/']:
            r=await post(app,path=path);self.assertEqual(r.status_code,404)
        self.assertEqual((await post(app,method='GET')).status_code,405)
    async def test_telemetry_disabled(self):
        app=enabled();self.assertTrue(all(app._telemetry[k] is False for k in ['tracing','metrics','logs','operation_spans','auto_configure']))
    async def test_auth_rejections(self):
        for value in ['', 'Bearer wrong', 'Bearer '+TOKEN.upper(),'Basic '+TOKEN,'Bearer jwt.patient.secret','Bearer '+'x'*1000]:
            h=headers();h['authorization']=value;r=await post(enabled(),hs=h)
            self.assertEqual(r.status_code,401);self.assertNotIn(value if value else 'unlikely',r.text)
        h=headers();h.pop('authorization');self.assertEqual((await post(enabled(),hs=h)).status_code,401)
    async def test_duplicate_auth_rejected(self):
        h=list(headers().items())+[('authorization','Bearer '+TOKEN)]
        self.assertEqual((await post(enabled(),hs=h)).status_code,401)
    async def test_constant_time_comparison(self):
        with patch('summary_service.app.hmac.compare_digest',wraps=hmac.compare_digest) as check:
            await post(enabled());self.assertEqual(check.call_count,1)
            self.assertEqual([len(x) for x in check.call_args.args],[32,32])
    async def test_deterministic_validated_response(self):
        app=enabled();a=await post(app);b=await post(app)
        self.assertEqual(a.status_code,200);self.assertTrue(a.content==b.content)
        validate_summary_output(a.json(),BASE['input'],BASE['context'],expected_recipe(BASE['context']['input_sha256']))
        self.assertEqual(a.headers['cache-control'],'no-store')
    async def test_missing_context(self):
        for header in CONTEXT_HEADERS.values():
            h=headers();h.pop(header);self.assertEqual((await post(enabled(),hs=h)).status_code,400)
    async def test_foreign_context(self):
        h=headers();h['x-summary-scope-token']='b'*64
        self.assertEqual((await post(enabled(),hs=h)).json()['error']['code'],'SCOPE_MISMATCH')
    async def test_foreign_input_digest(self):
        h=headers();h['x-summary-input-sha256']='b'*64
        self.assertEqual((await post(enabled(),hs=h)).json()['error']['code'],'PROVENANCE_MISMATCH')
    async def test_unknown_metadata_header(self):
        h=headers();h['x-summary-patient-id']='synthetic';self.assertEqual((await post(enabled(),hs=h)).status_code,400)
    async def test_duplicate_context(self):
        h=list(headers().items())+[('x-summary-source-ref',BASE['context']['source_ref'])]
        self.assertEqual((await post(enabled(),hs=h)).status_code,400)
    async def test_query_refused(self):self.assertEqual((await post(enabled(),path=PATH+'?token=synthetic')).status_code,400)
    async def test_request_metadata_refused(self):
        for k in ['patient_id','jwt','s3_object_key','source_path','job_state']:
            b=copy.deepcopy(BASE['input']);b[k]='synthetic-private'
            self.assertEqual((await post(enabled(),body=json.dumps(b).encode())).status_code,422)
    async def test_strict_wire_errors(self):
        for b in [b'{',b'null',b'{"schema_version":1,"schema_version":1}',b'\xff',b'{"n":NaN}']:
            self.assertEqual((await post(enabled(),body=b)).status_code,422)
    async def test_input_size(self):self.assertEqual((await post(enabled(),body=b'x'*262145)).status_code,413)
    async def test_bad_media_type(self):
        h=headers();h['content-type']='text/plain';self.assertEqual((await post(enabled(),hs=h)).status_code,415)
    async def test_compressed_body_refused(self):
        h=headers();h['content-encoding']='gzip';self.assertEqual((await post(enabled(),hs=h)).status_code,400)
    async def test_duplicate_length(self):
        h=list(headers().items())+[('content-length',str(len(raw()))),('content-length',str(len(raw())))]
        self.assertEqual((await post(enabled(),hs=h)).status_code,400)
    async def test_length_mismatch(self):
        h=headers();h['content-length']='1';self.assertEqual((await post(enabled(),hs=h)).status_code,400)
    async def test_oversized_headers(self):
        h=headers();h['other']='x'*9000;self.assertEqual((await post(enabled(),hs=h)).status_code,400)
    async def test_provider_failure_safe_no_retry(self):
        async def fail(s,r):raise RuntimeError('SYNTHETIC_SECRET_SENTINEL')
        p=FunctionProvider(fail);r=await post(enabled(p));self.assertEqual(r.status_code,502)
        self.assertNotIn('SYNTHETIC_SECRET_SENTINEL',r.text);self.assertEqual(p.calls,1)
    async def test_provider_mutation_does_not_change_authority(self):
        async def mutate(s,r):
            s['source']['text']='SYNTHETIC_MUTATION'
            s['facts'][0]['evidence']['quote']='SYNTHETIC_MUTATION'
            return await DeterministicFakeProvider().generate(s,r)
        self.assertEqual((await post(enabled(FunctionProvider(mutate)))).status_code,422)
    async def test_oversized_provider_output(self):
        async def big(s,r):return {'untrusted':'x'*131073}
        self.assertEqual((await post(enabled(FunctionProvider(big)))).status_code,422)
    async def test_deadline_cancels_provider(self):
        cancelled=asyncio.Event()
        async def slow(s,r):
            try:await asyncio.sleep(10)
            finally:cancelled.set()
        p=FunctionProvider(slow);r=await post(enabled(p,deadline_seconds=.03))
        self.assertEqual(r.status_code,504);await asyncio.wait_for(cancelled.wait(),.2);self.assertEqual(p.calls,1)
    async def test_concurrency_no_queue(self):
        entered=asyncio.Event();release=asyncio.Event()
        async def slow(s,r):entered.set();await release.wait();return await DeterministicFakeProvider().generate(s,r)
        p=FunctionProvider(slow);app=enabled(p);first=asyncio.create_task(post(app));await entered.wait()
        self.assertEqual((await post(app)).status_code,429);release.set();self.assertEqual((await first).status_code,200);self.assertEqual(p.calls,1)
    async def test_stubborn_cancellation_retains_capacity(self):
        release=asyncio.Event();cancelled=asyncio.Event()
        async def stubborn(s,r):
            try:await asyncio.sleep(10)
            except asyncio.CancelledError:cancelled.set();await release.wait()
            return await DeterministicFakeProvider().generate(s,r)
        app=enabled(FunctionProvider(stubborn),deadline_seconds=.03)
        self.assertEqual((await post(app)).status_code,504);await cancelled.wait()
        self.assertEqual((await post(app)).status_code,429);release.set();await asyncio.sleep(.02)
    async def test_caller_cancellation_cleans_provider(self):
        entered=asyncio.Event();cancelled=asyncio.Event()
        async def slow(s,r):
            entered.set()
            try:await asyncio.sleep(10)
            finally:cancelled.set()
        task=asyncio.create_task(post(enabled(FunctionProvider(slow))))
        await entered.wait();task.cancel()
        with self.assertRaises(asyncio.CancelledError):await task
        await asyncio.wait_for(cancelled.wait(),.2)
    async def test_disconnect_cancels_provider(self):
        entered=asyncio.Event();cancelled=asyncio.Event();sent=False;messages=[]
        async def slow(s,r):
            entered.set()
            try:await asyncio.sleep(10)
            finally:cancelled.set()
        async def receive():
            nonlocal sent
            if not sent:sent=True;return {'type':'http.request','body':raw(),'more_body':False}
            await entered.wait();return {'type':'http.disconnect'}
        async def send(message):messages.append(message)
        scope={'type':'http','asgi':{'version':'3.0'},'http_version':'1.1','method':'POST','scheme':'http','path':PATH,'raw_path':PATH.encode(),'query_string':b'','headers':[(k.encode(),v.encode()) for k,v in headers().items()],'client':('127.0.0.1',1),'server':('127.0.0.1',2)}
        await enabled(FunctionProvider(slow))(scope,receive,send)
        await asyncio.wait_for(cancelled.wait(),.2)
        self.assertEqual(messages[0]['status'],499)
    async def test_body_deadline(self):
        async def chunks():await asyncio.sleep(.1);yield raw()
        r=await post(enabled(deadline_seconds=.02),body=chunks());self.assertEqual(r.status_code,504)
    async def test_auth_before_body_consumption(self):
        async def chunks():raise AssertionError('BODY_READ_BEFORE_AUTH');yield b''
        r=await post(enabled(),body=chunks(),hs={});self.assertEqual(r.status_code,401)
    async def test_lifespan_shutdown_cancels_active_work(self):
        entered=asyncio.Event();cancelled=asyncio.Event()
        async def slow(s,r):
            entered.set()
            try:await asyncio.sleep(10)
            finally:cancelled.set()
        app=enabled(FunctionProvider(slow))
        async with app.router.lifespan_context(app):
            task=asyncio.create_task(post(app));await entered.wait()
        await asyncio.wait_for(cancelled.wait(),.2)
        try:await task
        except asyncio.CancelledError:pass
        self.assertEqual((await post(app)).status_code,503)
    async def test_shutdown_allows_async_provider_cleanup_without_double_cancel(self):
        entered=asyncio.Event();cleaned=asyncio.Event()
        async def slow(s,r):
            entered.set()
            try:await asyncio.sleep(10)
            finally:
                await asyncio.sleep(.02)
                cleaned.set()
        app=enabled(FunctionProvider(slow))
        async with app.router.lifespan_context(app):
            task=asyncio.create_task(post(app));await entered.wait()
        await asyncio.wait_for(cleaned.wait(),.2)
        try:await task
        except asyncio.CancelledError:pass
    async def test_exceptional_lifespan_exit_stays_closed(self):
        app=enabled()
        with self.assertRaisesRegex(RuntimeError,'SYNTHETIC_EXIT'):
            async with app.router.lifespan_context(app):
                raise RuntimeError('SYNTHETIC_EXIT')
        self.assertEqual((await post(app)).status_code,503)
    async def test_shutdown_during_body_prevents_provider_start(self):
        entered=asyncio.Event();calls=0
        async def candidate(s,r):
            nonlocal calls
            calls+=1
            return await DeterministicFakeProvider().generate(s,r)
        async def chunks():
            entered.set();await asyncio.sleep(10);yield raw()
        app=enabled(FunctionProvider(candidate))
        async with app.router.lifespan_context(app):
            task=asyncio.create_task(post(app,body=chunks()));await entered.wait()
        with self.assertRaises(asyncio.CancelledError):await task
        self.assertEqual(calls,0)
    async def test_streaming_size_without_content_length(self):
        async def chunks():
            yield b'x'*131072;yield b'x'*131073
        self.assertEqual((await post(enabled(),body=chunks())).status_code,413)
    async def test_empty_chunks_bounded(self):
        async def chunks():
            for _ in range(10001):yield b''
        self.assertEqual((await post(enabled(),body=chunks())).status_code,400)
    async def test_no_sensitive_service_logs(self):
        records=[]
        class Handler(logging.Handler):
            def emit(self,record):records.append(record.getMessage())
        logger=logging.getLogger();handler=Handler();logger.addHandler(handler)
        try:
            await post(enabled());await post(enabled(),hs={'authorization':'Bearer SYNTHETIC_SECRET_SENTINEL'})
        finally:logger.removeHandler(handler)
        self.assertTrue(all(TOKEN not in x and 'SYNTHETIC_SECRET_SENTINEL' not in x and BASE['input']['source']['text'] not in x for x in records))

# Each fixture is its own named test; failures reveal only fixture IDs/statuses.
def fixture_test(case):
    async def check(self):
        class Candidate:
            async def generate(self,s,r):
                out=copy.deepcopy(case['output'])
                if out.get('provenance')==case['recipe']:out['provenance']=r
                return out
        try:body=canonical_summary_json(case['input']).encode()
        except Exception:
            body=json.dumps(case['input'],ensure_ascii=True).encode()
        response=await post(enabled(Candidate()),body=body,hs=headers(case))
        expected=case.get('expected',case.get('expected_code'))
        # Fixture format uses code; never print payloads to discover mismatches.
        self.assertEqual(response.status_code==200, expected=='OK')
    return check
for i,c in enumerate(CASES):setattr(ServiceTests,'test_fixture_%02d'%i,fixture_test(c))
