import copy,hashlib,json,sys,unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'ai-service'))
from summary_contracts.validation import validate_summary_input,validate_summary_output,validate_summary_structure,render_summary,parse_summary_json,summary_input_digest,SummaryValidationError
CASES=json.loads((ROOT/'shared/medical-summary/fixtures.json').read_text())['cases']
class SummaryContracts(unittest.TestCase):
    def test_independent_draft_2020_12_schema_compatibility(self):
        from jsonschema import Draft202012Validator
        schema=json.loads((ROOT/'shared/medical-summary/v1.schema.json').read_text());Draft202012Validator.check_schema(schema)
        with patch('socket.socket.connect',side_effect=AssertionError('Network forbidden')):
            for c in CASES:
                for name,field in [('SummaryInputV1','input'),('SummaryOutputV1','output')]:
                    independent=Draft202012Validator({**schema,'$ref':'#/$defs/'+name}).is_valid(c[field])
                    self.assertTrue(independent==validate_summary_structure(name,c[field]),'Independent schema mismatch: '+c['id'])
    def test_reordering_does_not_change_rendering(self):
        c=copy.deepcopy(next(c for c in CASES if c['id']=='conflict'));a=render_summary(c['output'],c['input'],c['context'],c['recipe']);c['output']['reported_findings'].reverse()
        self.assertTrue(a==render_summary(c['output'],c['input'],c['context'],c['recipe']))
    def test_mutating_source_invalidates_render(self):
        c=copy.deepcopy(CASES[0]);validate_summary_output(c['output'],c['input'],c['context'],c['recipe']);c['input']['source']['text']+=' modified'
        with self.assertRaises(SummaryValidationError):render_summary(c['output'],c['input'],c['context'],c['recipe'])
    def test_redaction_and_removed_exception_context(self):
        c=copy.deepcopy(CASES[0]);c['output']['scope']['scope_token']='e'*64;error=None
        try:render_summary(c['output'],c['input'],c['context'],c['recipe'])
        except SummaryValidationError as e:error=e
        self.assertTrue(error is not None)
        rendered=str(error)+repr(error)
        self.assertTrue(all(s not in rendered for s in [c['input']['source']['text'],*c['input']['scope'].values()]))
        self.assertTrue(error.__context__ is None and error.__cause__ is None,'Unsafe exception chain')
    def test_valid_wire(self):
        c=CASES[0];v=parse_summary_json(json.dumps(c['input'],ensure_ascii=False).encode(),'input');self.assertTrue(summary_input_digest(v)==c['context']['input_sha256']);validate_summary_input(v,c['context'])
    def test_bad_wire_bytes_and_limits(self):
        for raw in [b'\xff',b' '*262145]:
            with self.assertRaises(SummaryValidationError):parse_summary_json(raw,'input')
def case_test(c):
    def run(self):
        code='OK';text=None
        try:validate_summary_output(c['output'],c['input'],c['context'],c['recipe']);text=render_summary(c['output'],c['input'],c['context'],c['recipe'])
        except SummaryValidationError as e:code=e.code
        self.assertEqual(code,c['expected'],c['id'])
        if c['expected']=='OK':
            self.assertTrue(bool(text))
            if 'expected_render_sha256' in c:self.assertTrue(hashlib.sha256(text.encode()).hexdigest()==c['expected_render_sha256'],'Golden rendering changed')
    return run
for c in CASES:setattr(SummaryContracts,'test_fixture_'+c['id'],case_test(c))
WIRES={'truncated':b'{"a":','duplicate':b'{"a":1,"a":2}','escaped_duplicate':b'{"a":1,"\\u0061":2}','float':b'{"a":1.0}','exponent':b'{"a":1e2}','nan':b'{"a":NaN}','infinity':b'{"a":Infinity}','trailing':b'{"a":1,}','trailing_array':b'[1,]','trailing_content':b'{} {}','unsafe_integer':b'9007199254740992','deep':b'['*25+b'0'+b']'*25,'invalid_surrogate':b'"\\ud800"','control':b'"\\u0000"'}
def wire_test(raw):
    def run(self):
        with self.assertRaises(SummaryValidationError):parse_summary_json(raw,'input')
    return run
for name,raw in WIRES.items():setattr(SummaryContracts,'test_wire_'+name,wire_test(raw))
if __name__=='__main__':unittest.main()
