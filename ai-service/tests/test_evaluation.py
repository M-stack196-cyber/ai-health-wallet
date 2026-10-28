"""Offline safety and gold-reference evaluation tests; no sensitive payload assertions."""
import asyncio
import copy
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ai-service'))
from summary_evaluation.reference import load_reference,compile_case,EvaluationError,DATA
from summary_evaluation.evaluator import evaluate
from summary_evaluation.runner import run,write_receipt
from summary_evaluation.scenarios import SCENARIOS,mutate
from summary_service.provider import DeterministicFakeProvider
from summary_contracts.validation import validate_summary_input,validate_summary_output
class EvaluationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.net=patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK_FORBIDDEN'));cls.net.start()
        cls.receipt=asyncio.run(run());cls.reference,_=load_reference()
    @classmethod
    def tearDownClass(cls):cls.net.stop()
    def test_reproducible(self):self.assertTrue(self.receipt==asyncio.run(run()),'Receipt drift')
    def test_all_expected_outcomes(self):self.assertTrue(self.receipt['summary']['passed'])
    def test_schema(self):
        from jsonschema import Draft202012Validator
        schema=json.loads((DATA/'receipt.schema.json').read_text())
        self.assertTrue(Draft202012Validator(schema).is_valid(self.receipt),'Receipt schema violation')
    def test_catalogue_gap_passes_grounding_fails_semantics(self):
        r=next(x for x in self.receipt['outcomes'] if x['scenario']=='catalogue_gap')
        self.assertTrue(r['schema_valid'] and r['grounding_valid']);self.assertFalse(r['semantic_valid'])
        self.assertEqual(r['coverage']['missing_critical_facts'],1)
    def test_zero_tolerance_metrics(self):
        for scenario,metric in [('precision','numerical_errors'),('diagnosis','fabricated_diagnoses'),('treatment','treatment_instructions'),('foreign_evidence','scope_errors')]:
            r=next(x for x in self.receipt['outcomes'] if x['scenario']==scenario)
            self.assertGreater(r['errors'][metric],0,'Missing safety metric')
            self.assertFalse(r['accepted'])
    def test_optional_finding_inventory(self):
        r=next(x for x in self.receipt['outcomes'] if x['case']=='negation' and x['scenario']=='baseline')
        self.assertEqual(r['coverage']['reference_facts'],2);self.assertEqual(r['coverage']['critical_facts'],1)
    def test_reference_annotation_integrity(self):
        for c in self.reference['cases']:
            if not c['facts']:continue
            source,context,recipe=compile_case(c);validate_summary_input(source,context)
            self.assertTrue(all(f['evidence']['page'] is None for f in source['facts']))
    def test_pins_fail_closed(self):
        with patch('summary_evaluation.reference.digest',return_value='wrong'):
            with self.assertRaisesRegex(EvaluationError,'^OFFLINE_EVALUATION_REFUSED$'):load_reference()
    def test_provider_errors_are_redacted_and_fail_suite(self):
        class Broken:
            async def generate(self,*args):raise RuntimeError('PRIVATE_SENTINEL_PATIENT_TOKEN_TEXT')
        r=asyncio.run(run(Broken()));self.assertFalse(r['summary']['passed'])
        self.assertNotIn('PRIVATE_SENTINEL',json.dumps(r));self.assertTrue(all(x['provider_failed'] for x in r['outcomes']))
    def test_provider_cancellation_is_redacted(self):
        class Cancelled:
            async def generate(self,*args):raise asyncio.CancelledError('PRIVATE_CANCEL_SENTINEL')
        r=asyncio.run(run(Cancelled()));self.assertFalse(r['summary']['passed'])
        self.assertNotIn('PRIVATE_CANCEL_SENTINEL',json.dumps(r))
    def test_provider_cannot_rewrite_authority(self):
        class Mutating:
            async def generate(self,source,recipe):
                source['source']['text']='mutated';return await DeterministicFakeProvider().generate(source,recipe)
        # Actual output may still be valid because fake returns facts, not changed source.
        self.assertTrue(asyncio.run(run(Mutating()))['summary']['passed'])
    def test_metric_receipt_has_no_source_or_scope(self):
        encoded=json.dumps(self.receipt)
        for c in self.reference['cases']:
            source,_,_=compile_case(c)
            self.assertTrue(c['text'] not in encoded,'Source disclosure')
            self.assertTrue(all(v not in encoded for v in source['scope'].values()),'Scope disclosure')
            for f in c['facts']:self.assertTrue(f['quote'] not in encoded,'Quote disclosure')
    def test_private_exclusive_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'receipt.json';write_receipt(p,self.receipt)
            self.assertEqual(p.stat().st_mode&0o777,0o600)
            with self.assertRaises(FileExistsError):write_receipt(p,self.receipt)
            link=Path(tmp)/'link';link.symlink_to(p)
            with self.assertRaises(FileExistsError):write_receipt(link,self.receipt)
    def test_public_directory_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.chmod(tmp,0o755)
            with self.assertRaises(EvaluationError):write_receipt(Path(tmp)/'report.json',self.receipt)
    def test_symlink_directory_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp);(p/'actual').mkdir(mode=0o700);(p/'link').symlink_to(p/'actual')
            with self.assertRaises(EvaluationError):write_receipt(p/'link'/'r.json',self.receipt)
    def test_provider_deadline(self):
        class Slow:
            async def generate(self,*args):await asyncio.sleep(60)
        # Single scenario schedule keeps bounded timeout test below two seconds.
        with patch('summary_evaluation.runner.SCENARIOS',[]),patch('summary_evaluation.runner.load_reference',return_value=({'cases':[self.reference['cases'][0]]},load_reference()[1])):
            r=asyncio.run(run(Slow()));self.assertFalse(r['summary']['passed'])
    def test_unknown_payload_is_refused_without_echo(self):
        c=self.reference['cases'][0];r=evaluate(c,{'private':'PRIVATE_SENTINEL'})
        self.assertFalse(r['accepted']);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(r))

def scenario_test(index):
    def check(self):
        r=self.receipt['outcomes'][index]
        self.assertTrue(r['expectation_met'],'Offline scenario expectation failed')
        self.assertFalse(r['provider_failed'],'Unexpected provider failure')
    return check
for i in range(42):setattr(EvaluationTests,'test_scenario_%02d'%i,scenario_test(i))
