"""Fixture-only parity report. Never accepts clinical input paths or payloads."""
from pathlib import Path
import hashlib,json,sys
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ai-service'))
from summary_contracts.validation import validate_summary_output,validate_summary_structure,render_summary,summary_input_digest,SummaryValidationError

def results():
    rows=[]
    for c in json.loads((ROOT/'shared/medical-summary/fixtures.json').read_text())['cases']:
        render=None
        try:
            validate_summary_output(c['output'],c['input'],c['context'],c['recipe'])
            render=hashlib.sha256(render_summary(c['output'],c['input'],c['context'],c['recipe']).encode()).hexdigest();code='OK'
        except SummaryValidationError as e:code=e.code
        try:input_hash=summary_input_digest(c['input'])
        except SummaryValidationError:input_hash=None
        rows.append({'id':c['id'],'code':code,'render_sha256':render,'input_sha256':input_hash,'input_structure':validate_summary_structure('SummaryInputV1',c['input']),'output_structure':validate_summary_structure('SummaryOutputV1',c['output'])})
    return rows
if __name__=='__main__':
    if len(sys.argv)!=1:raise SystemExit('Fixture checker accepts no arguments.')
    print(json.dumps(results(),separators=(',',':')))
