"""Frozen held-out preparation and synthetic port tests. Network calls forbidden."""
import asyncio,copy,json,socket,sys,tempfile,unittest
from dataclasses import asdict,replace
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ai-service'))
from summary_benchmark.contracts import BenchmarkError,BenchmarkReply,Budget,Limits,ModelIdentity,fingerprint
from summary_benchmark.preparation import DATA,prepare,load_frozen,scope_for,generation_settings
from summary_benchmark.offline import OfflineSession
from summary_service.provider import DeterministicFakeProvider
from summary_contracts.validation import canonical_summary_json
from summary_evaluation.reference import compile_case,EvaluationError
from summary_evaluation.evaluator import evaluate

def identity(**kwargs):
    _,pins=load_frozen()
    return ModelIdentity(**dict(provider='synthetic-offline',model='offline-test-model',revision='synthetic-rev-1',adapter_revision='offline-port-v1',tokenizer_sha256='a'*64,configuration_sha256=fingerprint(generation_settings()),prompt_sha256=pins['prompt_sha256'],input_microusd_per_token=0,output_microusd_per_token=0,**kwargs)) if not kwargs else replace(identity(),**kwargs)
class Fake:
    def __init__(self,mutate=None):self.calls=0;self.mutate=mutate
    async def generate(self,request):
        self.calls+=1
        if request.settings!=generation_settings() or fingerprint(request.settings)!=request.identity.configuration_sha256:raise RuntimeError('CONFIGURATION_MISMATCH')
        candidate=await DeterministicFakeProvider().generate(request.source,request.provenance)
        if self.mutate:self.mutate(candidate)
        return BenchmarkReply(candidate,request.identity.sha256,len(canonical_summary_json(request.source).encode()),len(canonical_summary_json(candidate).encode()))
def session(provider=None,**kwargs):
    spec=identity();return OfflineSession(spec,provider or Fake(),allowlist=(spec.sha256,),**kwargs)
class BenchmarkTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):cls.network=patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK_FORBIDDEN'));cls.network.start()
    @classmethod
    def tearDownClass(cls):cls.network.stop()
    def test_manifest_deterministic_schema(self):
        from jsonschema import Draft202012Validator
        a,b=prepare(),prepare();self.assertTrue(a==b,'Manifest drift')
        self.assertTrue(Draft202012Validator(json.loads((DATA/'manifest.schema.json').read_text())).is_valid(a),'Manifest schema refused')
    def test_disabled_no_provider_selected(self):
        m=prepare();self.assertFalse(m['external_execution_enabled']);self.assertIsNone(m['candidate_model']);self.assertEqual(m['provider_allowlist'],[]);self.assertTrue(all(not v for v in m['gates'].values()))
    def test_frozen_cases(self):
        cases,pins=load_frozen();self.assertEqual(len(cases),12);self.assertEqual(len({c['id'] for c in cases}),12)
        self.assertEqual(len({scope_for(c['id'])['source_ref'] for c in cases}),12)
    def test_pin_drift_refused(self):
        with patch('summary_benchmark.preparation.digest',return_value='changed'):
            with self.assertRaisesRegex(BenchmarkError,'^BENCHMARK_REFUSED$'):load_frozen()
    def test_no_keys_or_text_in_manifest(self):
        m=json.dumps(prepare());cases,_=load_frozen()
        for c in cases:
            source,_,_=compile_case(c,expected_scope=scope_for(c['id']))
            self.assertTrue(c['text'] not in m and all(f['quote'] not in m for f in c['facts']),'Source disclosure')
            self.assertTrue(all(v not in m for v in source['scope'].values()),'Scope disclosure')
    def test_provider_requires_explicit_exact_allowlist(self):
        with self.assertRaisesRegex(BenchmarkError,'^NOT_ALLOWLISTED$'):OfflineSession(identity(),Fake())
        spec=identity(revision='synthetic-rev-2')
        with self.assertRaisesRegex(BenchmarkError,'^NOT_ALLOWLISTED$'):OfflineSession(spec,Fake(),allowlist=(identity().sha256,))
    def test_allowlist_rejects_strings_wildcards_and_duplicates(self):
        spec=identity()
        for allowed in [spec.sha256,('*',),('prefix'+spec.sha256+'suffix',),(spec.sha256,spec.sha256)]:
            with self.assertRaisesRegex(BenchmarkError,'^NOT_ALLOWLISTED$'):OfflineSession(spec,Fake(),allowlist=allowed)
    def test_real_provider_cannot_be_composed(self):
        spec=identity(provider='unapproved-external')
        with self.assertRaisesRegex(BenchmarkError,'^NOT_ALLOWLISTED$'):OfflineSession(spec,Fake(),allowlist=(spec.sha256,))
    def test_aliases_refused(self):
        for field in ['provider','model','revision','adapter_revision']:
            for alias in ['auto','default','latest']:
                with self.assertRaises(BenchmarkError):identity(**{field:alias})
    def test_price_and_hash_validation(self):
        for kw in [dict(input_microusd_per_token=-1),dict(output_microusd_per_token=True),dict(configuration_sha256='untrusted-secret'),dict(provider='provider/invalid')]:
            with self.assertRaisesRegex(BenchmarkError,'^BENCHMARK_REFUSED$'):identity(**kw)
    def test_prompt_and_configuration_binding(self):
        for kw in [dict(prompt_sha256='0'*64),dict(configuration_sha256='0'*64)]:
            spec=identity(**kw)
            with self.assertRaisesRegex(BenchmarkError,'^IDENTITY_MISMATCH$'):OfflineSession(spec,Fake(),allowlist=(spec.sha256,))
    def test_limit_validation(self):
        for kw in [dict(concurrency=2),dict(timeout_ms=0),dict(max_requests=13),dict(max_input_tokens=16001),dict(max_output_tokens=8001),dict(spending_cap_microusd=1000001),dict(spending_cap_microusd=-1),dict(max_requests=True)]:
            with self.assertRaises(BenchmarkError):Limits(**kw)
    def test_budget_reserves_before_request_and_does_not_refund(self):
        b=Budget(Limits(max_requests=2,spending_cap_microusd=24000),identity(input_microusd_per_token=1,output_microusd_per_token=1))
        b.reserve(100);self.assertEqual(b.reserved_microusd,24000)
        with self.assertRaisesRegex(BenchmarkError,'^LIMIT_EXCEEDED$'):b.reserve(100)
        self.assertEqual(b.requests,1)
    def test_request_and_token_limits(self):
        b=Budget(Limits(max_requests=1),identity());b.reserve(100)
        with self.assertRaises(BenchmarkError):b.reserve(100)
        with self.assertRaises(BenchmarkError):Budget(Limits(),identity()).reserve(16001)
    async def test_all_heldout_fake_results_use_existing_scorer(self):
        s=session();cases,_=load_frozen()
        for c in cases:self.assertTrue((await s.run_case(c['id']))['accepted'],'Synthetic candidate refused')
        self.assertEqual(s.budget.requests,12);self.assertEqual(s.budget.reserved_microusd,0)
    async def test_numerical_fidelity(self):
        s=session(Fake(lambda o:o['reported_findings'][0]['measurement']['value'].update(decimal='4.25')))
        r=await s.run_case('H01');self.assertFalse(r['accepted']);self.assertGreater(r['errors']['numerical_errors'],0)
    async def test_negation_reversal(self):
        r=await session(Fake(lambda o:o['reported_findings'][0].update(polarity='affirmed'))).run_case('H02')
        self.assertFalse(r['accepted']);self.assertGreater(r['errors']['negation_errors'],0)
    async def test_critical_omission(self):
        r=await session(Fake(lambda o:o['reported_findings'].pop())).run_case('H03')
        self.assertFalse(r['accepted']);self.assertGreater(r['coverage']['missing_critical_facts'],0)
    async def test_ambiguity_cannot_be_interpreted(self):
        r=await session(Fake(lambda o:o['reported_findings'][0].update(certainty='explicit'))).run_case('H04')
        self.assertFalse(r['accepted']);self.assertGreater(r['errors']['uncertainty_errors'],0)
    async def test_conflicts_are_preserved(self):
        r=await session(Fake(lambda o:o['reported_findings'].pop())).run_case('H05');self.assertFalse(r['accepted'])
    async def test_injection_cannot_add_instructions(self):
        r=await session(Fake(lambda o:o.update(treatment_instructions='SYNTHETIC_FORBIDDEN_INSTRUCTION'))).run_case('H06')
        self.assertFalse(r['accepted']);self.assertGreater(r['errors']['treatment_instructions'],0)
    async def test_cross_scope_output_is_rejected(self):
        foreign=scope_for('H08')
        r=await session(Fake(lambda o:o.update(scope=foreign))).run_case('H07')
        self.assertFalse(r['accepted']);self.assertGreater(r['errors']['scope_errors'],0)
    async def test_foreign_case_replay_is_rejected(self):
        captured=[]
        class Replay(Fake):
            async def generate(self,request):
                reply=await super().generate(request)
                if captured:return replace(reply,candidate=captured[0])
                captured.append(copy.deepcopy(reply.candidate));return reply
        s=session(Replay());self.assertTrue((await s.run_case('H07'))['accepted']);self.assertFalse((await s.run_case('H08'))['accepted'])
    async def test_fabricated_diagnosis_rejected(self):
        def add(o):
            f=copy.deepcopy(o['reported_findings'][0]);f.update(id='F999',kind='reported_diagnosis');o['reported_findings'].append(f)
        r=await session(Fake(add)).run_case('H11');self.assertFalse(r['accepted']);self.assertGreater(r['errors']['fabricated_diagnoses'],0)
    async def test_missing_unit_cannot_be_invented(self):
        def add(o):
            f=o['reported_findings'][0];f['measurement']['unit']={'text':'mg/dL','evidence':copy.deepcopy(f['evidence'])}
        self.assertFalse((await session(Fake(add)).run_case('H09'))['accepted'])
    async def test_changed_provider_identity_stops(self):
        class Wrong(Fake):
            async def generate(self,r):return replace(await super().generate(r),identity_sha256='0'*64)
        s=session(Wrong())
        with self.assertRaisesRegex(BenchmarkError,'^IDENTITY_MISMATCH$'):await s.run_case('H01')
        self.assertTrue(s.stopped)
    async def test_usage_and_size_caps(self):
        class Over(Fake):
            async def generate(self,r):return replace(await super().generate(r),output_tokens=8001)
        with self.assertRaisesRegex(BenchmarkError,'^LIMIT_EXCEEDED$'):await session(Over()).run_case('H01')
    async def test_input_budget_admission_precedes_provider(self):
        p=Fake();s=session(p,limits=Limits(max_input_tokens=1))
        with self.assertRaisesRegex(BenchmarkError,'^LIMIT_EXCEEDED$'):await s.run_case('H01')
        self.assertEqual(p.calls,0)
    async def test_spend_cap_precedes_provider(self):
        p=Fake();spec=identity(input_microusd_per_token=1);s=OfflineSession(spec,p,allowlist=(spec.sha256,),limits=Limits(spending_cap_microusd=0))
        with self.assertRaises(BenchmarkError):await s.run_case('H01')
        self.assertEqual(p.calls,0)
    async def test_timeout_no_retry(self):
        class Slow(Fake):
            async def generate(self,r):self.calls+=1;await asyncio.sleep(10)
        p=Slow();s=session(p,limits=Limits(timeout_ms=10))
        with self.assertRaisesRegex(BenchmarkError,'^DEADLINE_EXCEEDED$'):await s.run_case('H01')
        self.assertEqual(p.calls,1);self.assertTrue(s.stopped);self.assertEqual(s.budget.requests,1)
    async def test_timeout_discards_late_result(self):
        class Late(Fake):
            async def generate(self,r):
                try:await asyncio.sleep(10)
                except asyncio.CancelledError:await asyncio.sleep(0.03)
                return await super().generate(r)
        s=session(Late(),limits=Limits(timeout_ms=10));start=asyncio.get_running_loop().time()
        with self.assertRaisesRegex(BenchmarkError,'^DEADLINE_EXCEEDED$'):await s.run_case('H01')
        self.assertLess(asyncio.get_running_loop().time()-start,0.5)
        with self.assertRaises(BenchmarkError):await s.run_case('H02')
        await asyncio.sleep(0.05)
    async def test_concurrency_one(self):
        entered=asyncio.Event();release=asyncio.Event()
        class Waiting(Fake):
            async def generate(self,r):entered.set();await release.wait();return await super().generate(r)
        s=session(Waiting());work=asyncio.create_task(s.run_case('H01'));await entered.wait()
        try:
            with self.assertRaisesRegex(BenchmarkError,'^BUSY$'):await s.run_case('H02')
        finally:release.set();await work
    async def test_failure_redaction_and_no_fallback(self):
        class Broken(Fake):
            async def generate(self,r):self.calls+=1;raise RuntimeError('SYNTHETIC_PRIVATE_SENTINEL')
        p=Broken();s=session(p)
        with self.assertRaises(BenchmarkError) as e:await s.run_case('H01')
        self.assertNotIn('SYNTHETIC_PRIVATE',str(e.exception));self.assertIsNone(e.exception.__context__);self.assertIsNone(e.exception.__cause__);self.assertEqual(p.calls,1);self.assertTrue(s.stopped)
    async def test_cancellation_stops_without_retry(self):
        class Cancelled(Fake):
            async def generate(self,r):raise asyncio.CancelledError('SYNTHETIC_PRIVATE_SENTINEL')
        s=session(Cancelled())
        with self.assertRaisesRegex(BenchmarkError,'^DEADLINE_EXCEEDED$'):await s.run_case('H01')
        self.assertTrue(s.stopped)
    def test_untrusted_provenance_cannot_set_expected_input(self):
        case=load_frozen()[0][0];source,context,recipe=compile_case(case)
        recipe['input_sha256']='0'*64
        with self.assertRaises(EvaluationError):evaluate(case,{},expected_provenance=recipe)
    def test_invalid_expected_scope_refused(self):
        with self.assertRaises(EvaluationError):compile_case(load_frozen()[0][0],expected_scope={'patient_id':'SYNTHETIC_PRIVATE'})
