"""Explicit offline CLI; receipt contains only bounded public labels, hashes and counts."""
import argparse
import asyncio
import copy
import hashlib
import json
import os
from pathlib import Path
from summary_service.provider import DeterministicFakeProvider
from .reference import EvaluationError,compile_case,load_reference,digest
from .evaluator import VERSION,evaluate
from .scenarios import SCENARIOS,mutate
async def run(provider=None):
    ref,pins=load_reference(); provider=provider if provider is not None else DeterministicFakeProvider()
    results=[];cases={c['id']:c for c in ref['cases']}
    schedule=[(c['id'],'baseline',bool(c['facts'])) for c in ref['cases']]+SCENARIOS
    for case_id,mutation,expected in schedule:
        case=cases[case_id];source,context,recipe=compile_case(case)
        # Provider mutations cannot rewrite reference authority.
        try:
            candidate=await asyncio.wait_for(provider.generate(copy.deepcopy(source),copy.deepcopy(recipe)),timeout=1)
            if mutation!='baseline':candidate,source,context,recipe=mutate(mutation,case,candidate,source,context,recipe)
            result=evaluate(case,candidate,source,context,recipe)
            result['provider_failed']=False
        except (Exception, asyncio.CancelledError):
            result={'accepted':False,'provider_failed':True}
        # Unexpected provider errors must never count as a successful adversarial rejection.
        result.update(case=case_id,scenario=mutation,expected_acceptance=expected,
                      expectation_met=not result['provider_failed'] and result['accepted']==expected)
        results.append(result)
    modules=('reference.py','evaluator.py','scenarios.py','runner.py')
    evaluator_hash=digest(b''.join((Path(__file__).parent/p).read_bytes() for p in modules)+b''.join((Path(__file__).parents[1]/p).read_bytes() for p in ('summary_contracts/validation.py','summary_service/provider.py','summary_service/protocol.py')))
    fixture_hash=digest(json.dumps(pins,sort_keys=True,separators=(',',':')).encode())
    return {'schema_version':1,'kind':'offline-summary-evaluation','evaluator_version':VERSION,
            'evaluator_sha256':evaluator_hash,'fixture_set_sha256':fixture_hash,'reference_pins':pins,
            'synthetic_only':True,'clinical_validation':False,
            'thresholds':{'critical_coverage_percent':100,'catalogued_coverage_percent':100,'unsupported_claims':0,
                          'numerical_errors':0,'fabricated_diagnoses':0,'treatment_instructions':0,'scope_errors':0},
            'summary':{'scenarios':len(results),'expectations_met':sum(r['expectation_met'] for r in results),
                       'accepted':sum(r['accepted'] for r in results),'passed':all(r['expectation_met'] for r in results)},
            'outcomes':results}
def write_receipt(path,receipt):
    # Caller supplies an existing private directory; exclusive create prevents overwrite/symlink races.
    parent=path.parent
    if parent.is_symlink() or not parent.is_dir() or parent.stat().st_uid!=os.getuid() or parent.stat().st_mode&0o077:raise EvaluationError()
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as file:json.dump(receipt,file,sort_keys=True,indent=2);file.write('\n')
def main():
    parser=argparse.ArgumentParser(description='Synthetic offline evaluation only')
    parser.add_argument('--receipt',type=Path,required=True);args=parser.parse_args()
    try:
        receipt=asyncio.run(run());write_receipt(args.receipt,receipt)
        print(json.dumps(receipt['summary'],sort_keys=True));return 0 if receipt['summary']['passed'] else 1
    except Exception:
        print('OFFLINE_EVALUATION_REFUSED');return 1
if __name__=='__main__':raise SystemExit(main())
