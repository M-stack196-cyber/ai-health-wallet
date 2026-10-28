"""Frozen held-out data and deterministic manifest; CLI cannot execute a provider."""
import argparse,copy,hashlib,json
from dataclasses import asdict
from pathlib import Path
from uuid import UUID,uuid5
from summary_contracts.validation import validate_summary_input
from summary_evaluation.reference import compile_case,load_reference,digest
from summary_evaluation.evaluator import VERSION
from summary_evaluation.runner import write_receipt
from .contracts import BenchmarkError,Limits,fingerprint
ROOT=Path(__file__).resolve().parents[2]
DATA=ROOT/'shared/medical-summary/benchmark'
NAMESPACE=UUID('1423c720-421c-4b43-a6d8-2994acfc9ab0')
def scope_for(case_id):
    return {'request_id':str(uuid5(NAMESPACE,'request:'+case_id)),
            'source_ref':str(uuid5(NAMESPACE,'source:'+case_id)),
            'scope_token':hashlib.sha256(('synthetic-held-out:'+case_id).encode()).hexdigest()}
def generation_settings():
    return {'temperature_decimal':'0','top_p_decimal':'1','seed':0,'tools_enabled':False,
            'retrieval_enabled':False,'response_format':'SummaryOutputV1'}
def load_frozen():
    try:
        pins=json.loads((DATA/'pins-v1.json').read_bytes())
        for name,key in [('held-out-v1.json','cases_sha256'),('prompt-v1.txt','prompt_sha256'),('manifest.schema.json','manifest_schema_sha256')]:
            if digest((DATA/name).read_bytes())!=pins[key]:raise BenchmarkError()
        _,old_pins=load_reference()
        for key in ['glossary_sha256','schema_sha256']:
            if pins[key]!=old_pins[key]:raise BenchmarkError()
        reference=json.loads((DATA/'held-out-v1.json').read_bytes())
        if reference['split']!='held-out-synthetic-v1' or reference['clinical_review']!='pending' or reference['independent_of_candidate_output'] is not True:raise BenchmarkError()
        cases=reference['cases']
        if len(cases)!=12 or len({c['id'] for c in cases})!=12:raise BenchmarkError()
        implementation=json.loads((ROOT/'shared/medical-summary/evaluation/reference-v1.json').read_bytes())['cases']
        earlier=json.loads((ROOT/'shared/medical-summary/fixtures.json').read_bytes())['cases']
        known={c['text'] for c in implementation}|{c['input']['source']['text'] for c in earlier}
        known_quotes={f['quote'] for c in implementation for f in c['facts']}|{f['evidence']['quote'] for c in earlier for f in c['input']['facts']}
        for case in cases:
            if any(f['quote'] in known_quotes for f in case['facts']):raise BenchmarkError()
            if case['text'] in known or not case['text'].startswith('SYNTHETIC HELD-OUT'):raise BenchmarkError()
            source,context,_=compile_case(case,expected_scope=scope_for(case['id']))
            validate_summary_input(source,context)
        return copy.deepcopy(cases),pins
    except Exception:pass
    raise BenchmarkError()
def evaluator_identity():
    paths=['summary_evaluation/reference.py','summary_evaluation/evaluator.py','summary_contracts/validation.py','summary_service/protocol.py']
    return digest(b''.join((ROOT/'ai-service'/p).read_bytes() for p in paths))
def prepare():
    cases,pins=load_frozen();limits=Limits()
    requests=[]
    for case in cases:
        source,context,_=compile_case(case,expected_scope=scope_for(case['id']))
        requests.append({'case':case['id'],'topic':case['topic'],'input_sha256':context['input_sha256'],
                         'reference_facts':len(case['facts']),'critical_facts':sum(f['critical'] for f in case['facts'])})
    modules=['contracts.py','preparation.py','offline.py']
    return {'schema_version':1,'kind':'summary-benchmark-preparation','benchmark_version':'held-out-synthetic-v1',
            'mode':'dry-run','external_execution_enabled':False,'synthetic_only':True,
            'candidate_model':None,'provider_allowlist':[],'clinical_review':'pending','privacy_review':'pending',
            'fixture_set_sha256':fingerprint(pins),'pins':pins,'evaluator_version':VERSION,'evaluator_sha256':evaluator_identity(),
            'preparation_sha256':digest(b''.join((Path(__file__).parent/p).read_bytes() for p in modules)),
            'limits':asdict(limits),'currency':'USD','dry_run_spend_microusd':0,'estimated_live_spend_microusd':None,
            'generation_settings':generation_settings(),'generation_settings_sha256':fingerprint(generation_settings()),
            'planned_request_count':len(requests),'automatic_retries':0,'requests':requests,
            'gates':{'provider_identity_pinned':False,'provider_allowlisted':False,'pricing_verified':False,
                     'privacy_verified':False,'clinical_gold_approved':False,'glossary_approved':False,
                     'live_execution_authorized':False,'external_adapter_implemented':False}}
def main():
    parser=argparse.ArgumentParser(description='Offline preparation only; no live execution mode')
    parser.add_argument('--manifest',type=Path,required=True);args=parser.parse_args()
    try:
        manifest=prepare();write_receipt(args.manifest,manifest)
        print(json.dumps({'mode':'dry-run','cases':manifest['planned_request_count'],'external_calls':0,'spend_microusd':0},sort_keys=True));return 0
    except Exception:
        print('BENCHMARK_PREPARATION_REFUSED');return 1
if __name__=='__main__':raise SystemExit(main())
