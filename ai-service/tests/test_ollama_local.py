"""Fake HTTP/streams only. Never contact Ollama, a provider, AWS or a database."""
import asyncio
import copy
import hashlib
import json
import os
import socket
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch, AsyncMock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ai-service'))
from summary_benchmark.ollama_local import (MODEL, DIGEST, VERSION, LocalPolicy,
    OllamaLocalProvider, LocalRefusal, HostAdmission, trusted_recipe, refuse_proxies,
    output_schema)
from summary_benchmark.ollama_http import (ENDPOINT, HttpReply, LoopbackHttpTransport,
    TransportRefused)
from summary_benchmark.ollama_session import OllamaBenchmarkSession, OllamaBenchmarkBridge
from summary_benchmark.contracts import BenchmarkRequest
from summary_benchmark.preparation import DATA
from summary_benchmark.preparation import load_frozen, prepare
from summary_benchmark.contracts import Limits
from summary_service.provider import DeterministicFakeProvider
from summary_contracts.validation import canonical_summary_json

TEMPLATE = 'SYNTHETIC_REVIEWED_TEMPLATE'
PARAMETERS = 'SYNTHETIC_REVIEWED_PARAMETERS'
SHA = lambda s: hashlib.sha256(s.encode()).hexdigest()


class Counter:
    # Fake count only. This is not a production tokenizer implementation.
    model_digest = DIGEST
    template_sha256 = SHA(TEMPLATE)
    tokenizer_sha256 = 'a' * 64
    revision = 'synthetic-counter-v1'
    tokens = 1500
    def count(self, messages): return self.tokens


def host():
    return HostAdmission(True, True, True, True, 3 * 1024**3, 1301251357, 2, True)


class FakeHttp:
    def __init__(self, mutate=None):
        self.calls = []
        self.mutate = mutate
        self.fail = None
        self.delay = None
        self.tags = {'models': [{'name': MODEL, 'model': MODEL, 'digest': DIGEST},
            {'name': 'nomic-embed-text:latest', 'model': 'nomic-embed-text:latest', 'digest': 'b'*64}]}
        self.show = {'template': TEMPLATE, 'parameters': PARAMETERS,
            'model_info': {'general.architecture': 'qwen2'},
            'capabilities': ['completion', 'thinking'], 'thinking': None}
        self.version = {'version': VERSION}
        self.status = 200
        self.after_chat = None
        self.raw = None

    async def request(self, method, path, payload, **limits):
        self.calls.append((method, path))  # No bodies/reasoning in diagnostics.
        if self.fail: raise RuntimeError(self.fail)
        if path == '/api/chat':
            if self.delay: await self.delay()
            self.last_options = copy.deepcopy(payload['options'])
            self.last_format = copy.deepcopy(payload['format'])
            self.last_stream = payload['stream']
            self.last_think = payload.get('think', 'absent')
            bundle = json.loads(payload['messages'][1]['content'])
            candidate = await DeterministicFakeProvider().generate(bundle['input'], bundle['provenance'])
            result = {'model': MODEL, 'done': True, 'done_reason': 'stop',
                'prompt_eval_count': 1000, 'eval_count': 800,
                'message': {'role': 'assistant', 'content': canonical_summary_json(candidate),
                            'thinking': 'SYNTHETIC_REASONING_SECRET'}}
            if self.mutate: self.mutate(result)
            if self.after_chat: self.after_chat(self)
            if self.raw is not None: return HttpReply(self.status, self.raw)
        else:
            result = {'/api/version': self.version, '/api/tags': self.tags, '/api/show': self.show}[path]
        return HttpReply(self.status, json.dumps(result, ensure_ascii=False).encode())


def provider(http=None, **kw):
    args = dict(transport=http or FakeHttp(), host_check=host, accountant=Counter(),
        template_sha256=SHA(TEMPLATE), parameters_sha256=SHA(PARAMETERS), enabled=True)
    args.update(kw)
    return OllamaLocalProvider(**args)


def source_for(p, case_id='H01'):
    case = next(c for c in load_frozen()[0] if c['id'] == case_id)
    source, _, recipe = trusted_recipe(case, p.identity)
    return source, recipe


def session(p):
    return OllamaBenchmarkSession(p, enabled=True, allowlist=(p.identity.sha256,))


def edit_candidate(reply, fn):
    candidate = json.loads(reply['message']['content'])
    fn(candidate)
    reply['message']['content'] = json.dumps(candidate)


class LocalTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.network = patch.object(socket.socket, 'connect', side_effect=AssertionError('NETWORK_FORBIDDEN'))
        self.network.start()
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.network.stop()

    async def test_disabled_provider_no_external_effects(self):
        h = FakeHttp(); p = provider(h, enabled=False)
        with self.assertRaisesRegex(LocalRefusal, '^DISABLED$'): await p.generate(*source_for(p))
        self.assertEqual(h.calls, [])

    async def test_disabled_session(self):
        p = provider(); s = OllamaBenchmarkSession(p, allowlist=(p.identity.sha256,))
        with self.assertRaisesRegex(LocalRefusal, '^DISABLED$'): await s.run_case('H01')
        self.assertEqual(p.transport.calls, [])

    def test_endpoint_exact_only(self):
        for endpoint in ['https://127.0.0.1:11434', 'http://localhost:11434',
                         'http://0.0.0.0:11434', ENDPOINT+'/', ENDPOINT+'@remote', 'https://ollama.com']:
            with self.assertRaises(LocalRefusal): provider(endpoint=endpoint)
            with self.assertRaises(TransportRefused): LoopbackHttpTransport(endpoint=endpoint)

    def test_proxy_refusal(self):
        for key in ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']:
            with self.assertRaisesRegex(LocalRefusal, '^PROXY_REFUSED$'):
                refuse_proxies({key: 'SYNTHETIC_PROXY_SECRET'})

    async def test_proxy_before_metadata(self):
        p = provider()
        with patch.dict(os.environ, {'HTTPS_PROXY': 'SYNTHETIC_PROXY_SECRET'}):
            with self.assertRaisesRegex(LocalRefusal, '^PROXY_REFUSED$'): await p.generate(*source_for(p))
        self.assertEqual(p.transport.calls, [])

    def test_existing_defaults_unchanged(self):
        self.assertEqual(Limits().timeout_ms, 1000)
        self.assertIsNone(prepare()['candidate_model'])
        self.assertFalse(prepare()['external_execution_enabled'])
        with self.assertRaises(Exception): Limits(timeout_ms=180000)

    def test_invalid_policy(self):
        for kw in [dict(concurrency=2), dict(num_ctx=8192), dict(num_predict=2049),
                   dict(num_thread=4), dict(timeout_ms=180001), dict(max_requests=13),
                   dict(spending_cap_microusd=1), dict(num_predict=True),
                   dict(minimum_available_bytes=1), dict(maximum_process_tree_bytes=4*1024**3)]:
            with self.assertRaises(LocalRefusal): LocalPolicy(**kw)

    def test_counter_identity_binding(self):
        for field in ['model_digest', 'template_sha256', 'tokenizer_sha256', 'revision']:
            c = Counter(); setattr(c, field, 'invalid revision' if field == 'revision' else 'invalid')
            with self.assertRaises(LocalRefusal): provider(accountant=c)

    async def test_host_refusal_flags(self):
        for field in ['loopback_only', 'cloud_disabled', 'telemetry_disabled', 'exclusive_daemon', 'cpu_only']:
            p = provider(host_check=lambda f=field: replace(host(), **{f:False}))
            with self.assertRaisesRegex(LocalRefusal, '^HOST_REFUSED$'): await p.generate(*source_for(p))
            self.assertEqual(p.transport.calls, [])

    async def test_memory_and_cpu_admission(self):
        for kw in [dict(available_bytes=1), dict(process_tree_bytes=4*1024**3),
                   dict(physical_cores=1), dict(available_bytes=True), dict(process_tree_bytes=0)]:
            p = provider(host_check=lambda k=kw: replace(host(), **k))
            with self.assertRaisesRegex(LocalRefusal, '^RESOURCE_REFUSED$'): await p.generate(*source_for(p))
            self.assertEqual(p.transport.calls, [])

    async def test_fresh_resource_check_before_chat(self):
        n = 0
        def check():
            nonlocal n
            n += 1
            return host() if n == 1 else replace(host(), available_bytes=1)
        p = provider(host_check=check)
        with self.assertRaises(LocalRefusal): await p.generate(*source_for(p))
        self.assertNotIn(('POST', '/api/chat'), p.transport.calls)

    async def test_version_mismatch(self):
        h = FakeHttp(); h.version['version'] = 'other'
        p = provider(h)
        with self.assertRaisesRegex(LocalRefusal, '^IDENTITY_MISMATCH$'): await p.generate(*source_for(p))
        self.assertEqual(p.attempts, 0)

    async def test_digest_missing_duplicate_or_remote(self):
        for mutation in [lambda h:h.tags['models'][0].update(digest='0'*64),
                         lambda h:h.tags['models'].pop(0),
                         lambda h:h.tags['models'].append(copy.deepcopy(h.tags['models'][0])),
                         lambda h:h.tags['models'][0].update(remote_host='synthetic')]:
            h = FakeHttp(); mutation(h); p = provider(h)
            with self.assertRaisesRegex(LocalRefusal, '^IDENTITY_MISMATCH$'): await p.generate(*source_for(p))
            self.assertEqual(p.attempts, 0)

    async def test_show_template_parameters_architecture(self):
        for field, value in [('template', 'changed'), ('parameters', 'changed'),
                             ('model_info', {'general.architecture':'other'}), ('capabilities', []),
                             ('system', 'SYNTHETIC_UNPINNED_SYSTEM')]:
            h = FakeHttp(); h.show[field] = value; p = provider(h)
            with self.assertRaisesRegex(LocalRefusal, '^IDENTITY_MISMATCH$'): await p.generate(*source_for(p))

    async def test_postflight_retag_refuses_result(self):
        h = FakeHttp(); h.after_chat = lambda h:h.tags['models'][0].update(digest='0'*64)
        p = provider(h)
        with self.assertRaisesRegex(LocalRefusal, '^IDENTITY_MISMATCH$'): await p.generate(*source_for(p))
        self.assertTrue(p.stopped)

    async def test_only_frozen_source_and_recipe(self):
        for field in ['source', 'recipe']:
            p = provider(); source, recipe = source_for(p)
            if field == 'source': source['source']['text'] = 'SYNTHETIC_UNAPPROVED'
            else: recipe['provider'] = 'synthetic-fake'
            with self.assertRaisesRegex(LocalRefusal, '^IDENTITY_MISMATCH$'): await p.generate(source, recipe)
            self.assertEqual(p.transport.calls, [])

    async def test_context_refusal_no_truncation(self):
        for value in [2049, 4096, 0, True, '1500']:
            c = Counter(); c.tokens = value; p = provider(accountant=c)
            with self.assertRaisesRegex(LocalRefusal, '^CONTEXT_EXCEEDED$'): await p.generate(*source_for(p))
            self.assertEqual(p.attempts, 0)

    async def test_pinned_structured_request_and_thinking_discard(self):
        p = provider(); s = session(p)
        row = await s.run_case('H01')
        self.assertTrue(row['evaluation']['accepted'])
        self.assertEqual(p.transport.last_format, output_schema())
        self.assertFalse(p.transport.last_stream)
        self.assertEqual(p.transport.last_think, 'absent')
        self.assertEqual(p.transport.last_options, dict(num_ctx=4096, num_predict=2048,
            num_thread=2, num_gpu=0, temperature=0, top_p=1, seed=0))
        self.assertNotIn('SYNTHETIC_REASONING_SECRET', json.dumps(s.receipt()))

    async def test_explicit_false_thinking_control_only_when_supported(self):
        h = FakeHttp(); h.show['thinking'] = {'values':[True, False]}
        p = provider(h); await p.generate(*source_for(p))
        self.assertIs(h.last_think, False)

    async def test_thinking_only_embedded_prose_and_malformed(self):
        for content in ['', ' ', '<think>SYNTHETIC</think>{}', '{} trailing', '```json\n{}\n```', '{', '[]']:
            h = FakeHttp(lambda r,c=content:r['message'].update(content=c)); p = provider(h)
            with self.assertRaises(LocalRefusal): await p.generate(*source_for(p))

    async def test_tools_and_unknown_envelope_fields(self):
        for mutation in [lambda r:r['message'].update(tool_calls=[]),
                         lambda r:r['message'].update(extra='SYNTHETIC_SECRET'),
                         lambda r:r.update(extra='SYNTHETIC_SECRET')]:
            p = provider(FakeHttp(mutation))
            with self.assertRaisesRegex(LocalRefusal, '^RESPONSE_REFUSED$'): await p.generate(*source_for(p))

    async def test_truncation_wrong_model_and_invalid_usage(self):
        for kw in [dict(done=False), dict(done_reason='length'), dict(model='other'),
                   dict(eval_count=2049), dict(prompt_eval_count=1501), dict(eval_count=True)]:
            p = provider(FakeHttp(lambda r,k=kw:r.update(k)))
            with self.assertRaisesRegex(LocalRefusal, '^RESPONSE_REFUSED$'): await p.generate(*source_for(p))

    async def test_duplicate_json_keys_and_oversize(self):
        for raw in [b'{"done":true,"done":false}', b'{'*262145]:
            h = FakeHttp(); h.raw = raw; p = provider(h)
            with self.assertRaises(LocalRefusal): await p.generate(*source_for(p))

    async def test_numbers_and_units_no_repair(self):
        for mutate, metric in [
            (lambda o:o['reported_findings'][0]['measurement']['value'].update(decimal='4.25'), 'numerical_errors'),
            (lambda o:o['reported_findings'][0]['measurement']['unit'].update(text='changed'), 'unit_errors')]:
            p = provider(FakeHttp(lambda r,m=mutate:edit_candidate(r,m)))
            row = await session(p).run_case('H01')
            self.assertFalse(row['evaluation']['accepted'])
            self.assertGreater(row['evaluation']['errors'][metric], 0)
            self.assertEqual(p.attempts, 1)

    async def test_critical_omission_scored_not_repaired(self):
        p = provider(FakeHttp(lambda r:edit_candidate(r, lambda o:o['reported_findings'].pop())))
        row = await session(p).run_case('H03')
        self.assertFalse(row['evaluation']['accepted'])
        self.assertGreater(row['evaluation']['coverage']['missing_critical_facts'], 0)

    async def test_injection_and_fabricated_diagnosis(self):
        for case_id, mutate in [
            ('H06', lambda o:o.update(treatment_instructions='SYNTHETIC_FORBIDDEN')),
            ('H11', lambda o:o['reported_findings'].append({'id':'F999','kind':'reported_diagnosis'}))]:
            p = provider(FakeHttp(lambda r,m=mutate:edit_candidate(r,m)))
            row = await session(p).run_case(case_id)
            self.assertFalse(row['evaluation']['accepted'])

    async def test_scope_citation_negation_and_provenance(self):
        for case_id, mutation in [
            ('H07', lambda o:o['scope'].update(scope_token='0'*64)),
            ('H01', lambda o:o['reported_findings'][0]['evidence'].update(start_byte=0)),
            ('H02', lambda o:o['reported_findings'][0].update(polarity='affirmed')),
            ('H01', lambda o:o['provenance'].update(input_sha256='0'*64))]:
            p = provider(FakeHttp(lambda r,m=mutation:edit_candidate(r,m)))
            self.assertFalse((await session(p).run_case(case_id))['evaluation']['accepted'])

    async def test_all_frozen_cases_and_deterministic_redacted_receipt(self):
        receipts = []
        cases, _ = load_frozen()
        for _ in range(2):
            p = provider(); s = session(p)
            for case in cases: self.assertTrue((await s.run_case(case['id']))['evaluation']['accepted'])
            receipts.append(s.receipt())
        self.assertEqual(receipts[0], receipts[1])
        self.assertEqual(receipts[0]['execution_mode'], 'offline-fake-transport')
        self.assertFalse(receipts[0]['local_http_used'])
        self.assertTrue(receipts[0]['complete'])
        self.assertEqual(receipts[0]['generation_attempts'], 12)
        self.assertEqual(receipts[0]['external_spend_microusd'], 0)
        raw = json.dumps(receipts[0])
        for case in cases:
            self.assertNotIn(case['text'], raw)
            for v in source_for(p, case['id'])[0]['scope'].values(): self.assertNotIn(v, raw)

    async def test_allowlist_no_fake_or_default_selection(self):
        p = provider()
        for allowed in [(), ('*',), (p.identity.sha256, p.identity.sha256)]:
            with self.assertRaises(LocalRefusal): OllamaBenchmarkSession(p, enabled=True, allowlist=allowed)

    async def test_benchmark_port_binding(self):
        p = provider(); source, recipe = source_for(p)
        request = BenchmarkRequest(source, recipe, (DATA/'prompt-v1.txt').read_text(),
                                   p.identity, copy.deepcopy(p.settings), p.policy.num_predict)
        bridge = OllamaBenchmarkBridge(p, enabled=True)
        for changed in [replace(request, prompt='SYNTHETIC_CHANGED_PROMPT'),
                        replace(request, settings={}), replace(request, max_output_tokens=1),
                        replace(request, identity=replace(p.identity, input_microusd_per_token=1))]:
            with self.assertRaisesRegex(LocalRefusal, '^IDENTITY_MISMATCH$'): await bridge.generate(changed)
        self.assertEqual(p.attempts, 0)
        reply = await bridge.generate(request)
        self.assertEqual(reply.identity_sha256, p.identity.sha256)
        self.assertEqual((reply.input_tokens, reply.output_tokens), (1000,800))

    async def test_benchmark_port_disabled_default(self):
        p = provider()
        with self.assertRaisesRegex(LocalRefusal, '^DISABLED$'):
            await OllamaBenchmarkBridge(p).generate(None)
        self.assertEqual(p.transport.calls, [])

    async def test_accountant_mutation_refused_before_metadata(self):
        c = Counter(); p = provider(accountant=c)
        c.tokenizer_sha256 = 'b'*64
        with self.assertRaisesRegex(LocalRefusal, '^IDENTITY_MISMATCH$'): await p.generate(*source_for(p))
        self.assertEqual(p.transport.calls, [])

    async def test_attempt_cap_no_retry(self):
        p = provider(policy=LocalPolicy(max_requests=1)); s = session(p)
        await s.run_case('H01')
        with self.assertRaises(LocalRefusal): await s.run_case('H02')
        self.assertEqual(p.attempts, 1)

    async def test_run_deadline_blocks_new_case(self):
        p = provider(); s = session(p)
        s.started = asyncio.get_running_loop().time() - 2401
        with self.assertRaisesRegex(LocalRefusal, '^DEADLINE_EXCEEDED$'): await s.run_case('H01')
        self.assertTrue(s.stopped)
        self.assertEqual(p.attempts, 0)

    async def test_session_cancellation_records_failure_and_closes_admission(self):
        entered = asyncio.Event()
        async def wait(): entered.set(); await asyncio.sleep(10)
        h = FakeHttp(); h.delay = wait; p = provider(h); s = session(p)
        task = asyncio.create_task(s.run_case('H01')); await entered.wait(); task.cancel()
        with self.assertRaisesRegex(LocalRefusal, '^DEADLINE_EXCEEDED$'): await task
        self.assertTrue(s.stopped); self.assertTrue(p.stopped)
        self.assertEqual(s.receipt()['outcomes'][0]['failure'], 'DEADLINE_EXCEEDED')
        with self.assertRaises(LocalRefusal): await s.run_case('H02')

    async def test_production_transport_forbidden_routes(self):
        t = LoopbackHttpTransport(enabled=True)
        for method, path in [('POST','/api/pull'),('GET','http://remote/api/version'),
                             ('POST','/api/embed'),('POST','/api/generate')]:
            with self.assertRaises(TransportRefused):
                await t.request(method,path,None,timeout_s=1,max_bytes=100)

    async def test_case_collision_and_unknown_refusal(self):
        p = provider(); s = session(p); await s.run_case('H01')
        for case_id in ['H01', 'SYNTHETIC_SECRET']:
            with self.assertRaises(LocalRefusal): await s.run_case(case_id)
        self.assertEqual(p.attempts, 1)

    async def test_timeout_latches_admissions_no_retry(self):
        h = FakeHttp(); h.delay = lambda:asyncio.sleep(10)
        p = provider(h, policy=LocalPolicy(timeout_ms=10))
        s = session(p)
        with self.assertRaisesRegex(LocalRefusal, '^DEADLINE_EXCEEDED$'): await s.run_case('H01')
        self.assertTrue(p.stopped); self.assertTrue(s.stopped)
        with self.assertRaises(LocalRefusal): await s.run_case('H02')
        self.assertEqual(p.attempts, 1)

    async def test_noncooperative_transport_late_result_discarded(self):
        async def late():
            try: await asyncio.sleep(10)
            except asyncio.CancelledError: await asyncio.sleep(.03)
        h = FakeHttp(); h.delay = late
        p = provider(h, policy=LocalPolicy(timeout_ms=10))
        start = asyncio.get_running_loop().time()
        with self.assertRaisesRegex(LocalRefusal, '^DEADLINE_EXCEEDED$'): await p.generate(*source_for(p))
        self.assertLess(asyncio.get_running_loop().time()-start, .5)
        self.assertTrue(p.stopped)
        with self.assertRaises(LocalRefusal): await p.generate(*source_for(p))
        await asyncio.sleep(.06)

    async def test_cancellation_redacts_and_latches(self):
        entered = asyncio.Event()
        async def wait(): entered.set(); await asyncio.sleep(10)
        h = FakeHttp(); h.delay = wait; p = provider(h)
        task = asyncio.create_task(p.generate(*source_for(p))); await entered.wait()
        task.cancel('SYNTHETIC_CANCELLATION_SECRET')
        with self.assertRaisesRegex(LocalRefusal, '^DEADLINE_EXCEEDED$') as exc: await task
        self.assertIsNone(exc.exception.__context__)
        self.assertTrue(p.stopped)

    async def test_concurrency_one(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def wait(): entered.set(); await release.wait()
        h = FakeHttp(); h.delay = wait; p = provider(h)
        task = asyncio.create_task(p.generate(*source_for(p))); await entered.wait()
        try:
            with self.assertRaisesRegex(LocalRefusal, '^BUSY$'): await p.generate(*source_for(p))
        finally: release.set(); await task

    async def test_transport_redaction_and_no_credentials(self):
        h = FakeHttp(); h.fail = 'SYNTHETIC_PROVIDER_SECRET'; p = provider(h)
        with patch.dict(os.environ, {'OPENAI_API_KEY':'SYNTHETIC_PAID_KEY', 'AWS_SECRET_ACCESS_KEY':'SYNTHETIC_AWS_KEY'}):
            with self.assertRaisesRegex(LocalRefusal, '^TRANSPORT_REFUSED$') as exc:
                await p.generate(*source_for(p))
        self.assertIsNone(exc.exception.__context__)
        self.assertIsNone(exc.exception.__cause__)
        self.assertNotIn('SYNTHETIC', str(exc.exception))
        self.assertEqual(len(h.calls), 1)

    async def test_redirect_reply_refused(self):
        h = FakeHttp(); h.status = 302; p = provider(h)
        with self.assertRaisesRegex(LocalRefusal, '^TRANSPORT_REFUSED$'): await p.generate(*source_for(p))

    async def test_private_exclusive_receipt_writer(self):
        p = provider(); s = session(p); await s.run_case('H01')
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'receipt.json'
            s.write_receipt(path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(Exception): s.write_receipt(path)
            os.chmod(d, 0o755)
            with self.assertRaises(Exception): s.write_receipt(Path(d)/'unsafe.json')

    async def test_disabled_http_transport_no_socket(self):
        with self.assertRaises(TransportRefused):
            await LoopbackHttpTransport().request('GET','/api/version',None, timeout_s=1,max_bytes=100)

    async def test_fake_stream_transport_enforces_framing_and_closes(self):
        for status, headers, body, valid in [
            (b'200', b'Content-Type: application/json\r\nContent-Length: 2', b'{}', True),
            (b'302', b'Location: http://remote\r\nContent-Length: 2', b'{}', False),
            (b'200', b'Content-Type: application/json\r\nTransfer-Encoding: chunked', b'{}', False),
            (b'200', b'Content-Type: application/json\r\nContent-Length: 999', b'{}', False),
            (b'200', b'Content-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 2', b'{}', False)]:
            reader = asyncio.StreamReader()
            reader.feed_data(b'HTTP/1.1 '+status+b' Synthetic\r\n'+headers+b'\r\n\r\n'+body)
            reader.feed_eof()
            writer = type('Writer', (), {'write':lambda s,b:None, 'drain':AsyncMock(),
                'close':lambda s:setattr(s,'closed',True), 'wait_closed':AsyncMock()})()
            connector = AsyncMock(return_value=(reader,writer))
            with patch('asyncio.open_connection',connector):
                op = LoopbackHttpTransport(enabled=True).request('GET','/api/version',None,timeout_s=1,max_bytes=100)
                if valid: self.assertEqual((await op).body, b'{}')
                else:
                    with self.assertRaises(TransportRefused): await op
            self.assertTrue(writer.closed)
            self.assertEqual(connector.call_args.args, ('127.0.0.1',11434))


if __name__ == '__main__': unittest.main()
