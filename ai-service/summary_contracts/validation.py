"""Offline, conservative source-grounding contracts. No clients, services or logging."""
from __future__ import annotations
import copy,hashlib,json,math,re
from pathlib import Path
from typing import Any
from types import MappingProxyType
from .types import SummaryInputV1,SummaryOutputV1,SummaryProvenanceV1
ROOT=Path(__file__).resolve().parents[2]
def freeze(v):
    if type(v) is dict:return MappingProxyType({k:freeze(x) for k,x in v.items()})
    if type(v) is list:return tuple(freeze(x) for x in v)
    return v
SCHEMA=freeze(json.loads((ROOT/'shared/medical-summary/v1.schema.json').read_text()))
GLOSSARY=freeze(json.loads((ROOT/'shared/medical-summary/glossary-v1.json').read_text()))
LIMITS={'sourceBytes':32768,'inputBytes':262144,'outputBytes':131072,'renderBytes':32768,'depth':20}
CODES={'INVALID_INPUT','INVALID_OUTPUT','SOURCE_TOO_LARGE','INCOMPLETE_EXTRACTION','INVALID_EVIDENCE','UNSUPPORTED_CLAIM','SCOPE_MISMATCH','PROVENANCE_MISMATCH','VALIDATION_FAILED'}
class SummaryValidationError(Exception):
    def __init__(self,code:str):
        self.code=code if code in CODES else 'VALIDATION_FAILED'
        super().__init__('Medical summary validation refused: '+self.code)
    def __repr__(self):return 'SummaryValidationError('+self.code+')'
def require(ok:Any,code='VALIDATION_FAILED'):
    if not ok:raise SummaryValidationError(code)
def safe(fn):
    def wrapped(*args,**kwargs):
        # Raise outside the except block: no raw exception context/cause survives.
        try:return fn(*args,**kwargs)
        except SummaryValidationError as e:code=e.code
        except Exception:code='VALIDATION_FAILED'
        raise SummaryValidationError(code)
    return wrapped
def invalid_unicode(s):return bool(re.search('[\ud800-\udfff\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]',s))
@safe
def canonical_summary_json(value):
    nodes=0
    def walk(v,depth):
        nonlocal nodes
        nodes+=1;require(depth<=LIMITS['depth'] and nodes<=10000)
        if v is None:return 'null'
        if type(v) is bool:return 'true' if v else 'false'
        if type(v) in (int,float):
            require(math.isfinite(v) and int(v)==v and abs(v)<=9007199254740991)
            return str(int(v))
        if type(v) is str:
            require(not invalid_unicode(v));return json.dumps(v,ensure_ascii=False)
        if type(v) is list:return '['+','.join(walk(x,depth+1) for x in v)+']'
        require(type(v) is dict and all(type(k) is str and not invalid_unicode(k) for k in v))
        return '{'+','.join(json.dumps(k,ensure_ascii=False)+':'+walk(v[k],depth+1) for k in sorted(v))+'}'
    return walk(value,0)
def summary_input_digest(value):return hashlib.sha256(canonical_summary_json(value).encode('utf-8')).hexdigest()
def same(a,b):return canonical_summary_json(a)==canonical_summary_json(b)
VOCAB={'$ref','type','properties','required','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','pattern','minimum','maximum','enum','const','anyOf'}
@safe
def validate_summary_structure(name,value):
    def check(r,v,depth):
        if depth>LIMITS['depth'] or set(r)-VOCAB:return False
        if '$ref' in r:
            name=r['$ref'].removeprefix('#/$defs/')
            return r['$ref']=='#/$defs/'+name and name in SCHEMA['$defs'] and check(SCHEMA['$defs'][name],v,depth+1)
        if 'anyOf' in r:return any(check(x,v,depth+1) for x in r['anyOf'])
        scalar_equal=lambda a,b: (type(a) in (int,float) and type(b) in (int,float) and a==b) or (type(a) is type(b) and type(a) in (str,bool,type(None)) and a==b)
        if 'const' in r and not scalar_equal(v,r['const']):return False
        if 'enum' in r and not any(scalar_equal(v,x) for x in r['enum']):return False
        kind=r.get('type')
        if kind=='null':return v is None
        if kind=='boolean':return type(v) is bool
        if kind=='integer':return type(v) in (int,float) and math.isfinite(v) and int(v)==v and r['minimum']<=v<=r['maximum']
        if kind=='string':return type(v) is str and not invalid_unicode(v) and r['minLength']<=len(v)<=r['maxLength'] and ('pattern' not in r or re.search(r['pattern'],v) is not None)
        if kind=='array':return type(v) is list and r['minItems']<=len(v)<=r['maxItems'] and all(check(r['items'],x,depth+1) for x in v) and (not r.get('uniqueItems') or len({canonical_summary_json(x) for x in v})==len(v))
        if kind=='object':return type(v) is dict and r['additionalProperties'] is False and set(v)==set(r['required']) and all(check(rule,v[k],depth+1) for k,rule in r['properties'].items())
        return 'enum' in r or 'const' in r
    return check(SCHEMA['$defs'][name],value,0)
@safe
def parse_summary_json(raw:bytes,kind:str):
    require(kind in ('input','output'))
    require(len(raw)<=LIMITS['inputBytes' if kind=='input' else 'outputBytes'],'SOURCE_TOO_LARGE' if kind=='input' else 'INVALID_OUTPUT')
    code='INVALID_INPUT' if kind=='input' else 'INVALID_OUTPUT'
    def pairs(items):
        result={}
        for k,v in items:require(k not in result,code);result[k]=v
        return result
    def bad(_):raise SummaryValidationError(code)
    try:
        value=json.loads(raw.decode('utf-8'),object_pairs_hook=pairs,parse_float=bad,parse_constant=bad)
        canonical_summary_json(value)
    except Exception:value=None;failed=True
    else:failed=False
    require(not failed,code);return value

def evidence(e,input,parent=None):
    b=input['source']['text'].encode('utf-8');start,end=int(e['start_byte']),int(e['end_byte'])
    require(e['quote'].strip() and e['source_ref']==input['scope']['source_ref'] and e['page'] is None and 0<=start<end<=len(b),'INVALID_EVIDENCE')
    require(b[start:end]==e['quote'].encode('utf-8'),'INVALID_EVIDENCE')
    if parent:require(start>=parent['start_byte'] and end<=parent['end_byte'],'INVALID_EVIDENCE')
def validate_fact(f,input):
    evidence(f['evidence'],input)
    require(not re.search(r'ignore (?:all|previous|prior)|system (?:prompt|message)|api[_ -]?key|reveal.*(?:record|patient)|execute.*(?:command|shell)',f['evidence']['quote'],re.I),'UNSUPPORTED_CLAIM')
    m=f['measurement'];require((f['kind']=='measurement')==(m is not None),'UNSUPPORTED_CLAIM')
    if m:
        for k in ['label','value','operator','unit','reported_range','reported_flag']:
            if m[k] is not None:evidence(m[k]['evidence'],input,f['evidence'])
        for k in ['label','unit','reported_range']:
            if m[k] is not None:require(m[k]['text'].strip() and m[k]['text']==m[k]['evidence']['quote'],'UNSUPPORTED_CLAIM')
        if m['value']:
            v=m['value'];require(v['decimal']==v['evidence']['quote'] and f['certainty']=='explicit','UNSUPPORTED_CLAIM')
            b=input['source']['text'].encode();left=b[:int(v['evidence']['start_byte'])].decode();right=b[int(v['evidence']['end_byte']):].decode()
            boundary=lambda x:bool(x) and (x.isalnum() or x in '._,+-−')
            require(not boundary(left[-1:] or '') and not boundary(right[:1] or ''),'UNSUPPORTED_CLAIM')
        if m['operator']:require(m['value'] is not None and m['operator']['symbol']==m['operator']['evidence']['quote'],'UNSUPPORTED_CLAIM')
        if m['reported_flag']:
            mapping={'h':'high','high':'high','l':'low','low':'low','n':'normal','normal':'normal'}
            require(mapping.get(m['reported_flag']['evidence']['quote'].lower())==m['reported_flag']['value'],'UNSUPPORTED_CLAIM')
            flag=m['reported_flag']['evidence'];b=input['source']['text'].encode();left=b[:int(flag['start_byte'])].decode();right=b[int(flag['end_byte']):].decode()
            embedded=lambda x:bool(x) and (x.isalnum() or x in '_/.,+-−')
            require(not embedded(left[-1:] or '') and not embedded(right[:1] or ''),'UNSUPPORTED_CLAIM')
    for term in f['term_ids']:
        if term=='glucose':require(re.search(r'\bglucose\b',f['evidence']['quote'],re.I),'UNSUPPORTED_CLAIM')
        if term=='hemoglobin':require(re.search(r'\b(?:ha?emoglobin|hgb|hb)\b',f['evidence']['quote'],re.I),'UNSUPPORTED_CLAIM')
        if term=='reference_range':require(m is not None and m['reported_range'] is not None,'UNSUPPORTED_CLAIM')
        if term=='ocr':require(input['source']['method']!='pdf_text','UNSUPPORTED_CLAIM')
@safe
def validate_summary_input(raw,context)->SummaryInputV1:
    if type(raw) is dict and type(raw.get('source')) is dict and type(raw['source'].get('text')) is str:
        require(not invalid_unicode(raw['source']['text']),'INVALID_INPUT');require(len(raw['source']['text'].encode())<=LIMITS['sourceBytes'],'SOURCE_TOO_LARGE')
    require(validate_summary_structure('SummaryInputV1',raw),'INVALID_INPUT');input=raw
    require(len(canonical_summary_json(raw).encode())<=LIMITS['inputBytes'],'SOURCE_TOO_LARGE')
    require(same(input['scope'],{k:context[k] for k in ['request_id','source_ref','scope_token']}),'SCOPE_MISMATCH')
    require(input['source']['extraction_status']=='completed','INCOMPLETE_EXTRACTION')
    require(hashlib.sha256(input['source']['text'].encode()).hexdigest()==input['source']['text_sha256'] and summary_input_digest(input)==context['input_sha256'],'PROVENANCE_MISMATCH')
    require(input['source']['text'].strip() and len({f['id'] for f in input['facts']})==len(input['facts']),'INVALID_INPUT')
    groups={}
    for f in input['facts']:
        validate_fact(f,input)
        if f['conflict_group']:groups[f['conflict_group']]=groups.get(f['conflict_group'],0)+1
    require(all(n>=2 for n in groups.values()),'INVALID_INPUT');return copy.deepcopy(input)
def expected_metadata(input,facts):
    codes={'page_locations_unavailable'};ids=set();terms=set()
    if input['source']['method']!='pdf_text':codes.add('ocr_used');terms.add('ocr')
    if len(facts)<len(input['facts']):codes.add('limited_coverage')
    for f in facts:
        terms.update(f['term_ids'])
        if f['certainty']=='ambiguous':codes.add('ambiguous_source');ids.add(f['id'])
        if f['conflict_group']:codes.add('conflicting_findings');ids.add(f['id'])
        if f['measurement'] and f['measurement']['value'] is None:codes.add('missing_measurement_value');ids.add(f['id'])
        if f['measurement'] and f['measurement']['unit'] is None:codes.add('missing_unit');ids.add(f['id'])
    return {'codes':sorted(codes),'fact_ids':sorted(ids),'terms':sorted(terms)}
@safe
def validate_summary_output(raw,source,context,recipe)->SummaryOutputV1:
    input=validate_summary_input(source,context);require(validate_summary_structure('SummaryOutputV1',raw),'INVALID_OUTPUT');out=raw
    require(len(canonical_summary_json(out).encode())<=LIMITS['outputBytes'],'INVALID_OUTPUT')
    require(same(out['scope'],input['scope']),'SCOPE_MISMATCH')
    require(validate_summary_structure('SummaryProvenanceV1',recipe) and recipe['input_sha256']==context['input_sha256'] and same(out['provenance'],recipe),'PROVENANCE_MISMATCH')
    facts={f['id']:f for f in input['facts']};chosen={f['id'] for f in out['reported_findings']}
    require(len(chosen)==len(out['reported_findings']),'UNSUPPORTED_CLAIM')
    for f in out['reported_findings']:require(f['id'] in facts and same(f,facts[f['id']]),'UNSUPPORTED_CLAIM')
    require(all(not f['required'] or f['id'] in chosen for f in input['facts']),'UNSUPPORTED_CLAIM')
    for f in input['facts']:
        if f['conflict_group'] and f['id'] in chosen:require(all(x['id'] in chosen for x in input['facts'] if x['conflict_group']==f['conflict_group']),'UNSUPPORTED_CLAIM')
    meta=expected_metadata(input,out['reported_findings'])
    require(same(out['uncertainty'],{k:meta[k] for k in ['codes','fact_ids']}) and same(out['educational_explanations'],meta['terms']),'UNSUPPORTED_CLAIM')
    require(out['catalogue_coverage']==('all_catalogued' if len(chosen)==len(facts) else 'subset'),'UNSUPPORTED_CLAIM');return copy.deepcopy(out)
WARNINGS={'ambiguous_source':'Some extracted text is ambiguous; no uncertain number has been interpreted.','conflicting_findings':'The selected source statements conflict. The conflict has not been resolved.','limited_coverage':'This summary covers only part of the extracted report.','missing_measurement_value':'A measurement value is unavailable in this summary.','missing_unit':'A measurement unit is unavailable; no unit has been supplied.','ocr_used':'This report includes OCR text. Reading errors may remain.','page_locations_unavailable':'Verified page locations are unavailable.'}
@safe
def render_summary(raw,source,context,recipe)->str:
    output=validate_summary_output(raw,source,context,recipe);lines=['Report summary','Source-reported information; not an independent diagnosis.']
    for f in sorted(output['reported_findings'],key=lambda f:(f['evidence']['start_byte'],f['id'])):
        lines.append('Reported text: '+json.dumps(f['evidence']['quote'],ensure_ascii=False));m=f['measurement']
        if m:
            value=((m['operator']['symbol']+' ' if m['operator'] else '')+m['value']['decimal']) if m['value'] else 'unavailable'
            lines.append('Measurement: '+m['label']['text']+': '+value+(' '+m['unit']['text'] if m['unit'] else '; unit unavailable')+'.')
            if m['reported_range']:lines.append('Range printed in report: '+m['reported_range']['text']+'.')
            if m['reported_flag']:lines.append('Flag printed in report: '+m['reported_flag']['evidence']['quote']+'.')
    if output['educational_explanations']:lines.append('General explanations (not interpretations of your results):')
    lines.extend(GLOSSARY['entries'][term]['text'] for term in output['educational_explanations']);lines.append('Limitations:');lines.extend(WARNINGS[code] for code in output['uncertainty']['codes'])
    text='\n'.join(lines);require(len(text.encode())<=LIMITS['renderBytes'],'VALIDATION_FAILED');return text
