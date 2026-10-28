"""Pinned reference compiler, independent of candidates and production metadata helpers."""
import copy
import hashlib
import json
from pathlib import Path
from summary_contracts.validation import summary_input_digest
from summary_service.protocol import expected_recipe
ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'shared/medical-summary/evaluation'
class EvaluationError(Exception):
    def __init__(self): super().__init__('OFFLINE_EVALUATION_REFUSED')
def digest(raw): return hashlib.sha256(raw).hexdigest()
def load_reference():
    try:
        pins = json.loads((DATA / 'pins-v1.json').read_bytes())
        paths = [(DATA/'reference-v1.json','reference_sha256'),
                 (DATA.parent/'glossary-v1.json','glossary_sha256'),
                 (DATA.parent/'v1.schema.json','schema_sha256'),
                 (DATA/'scenarios-v1.json','scenarios_sha256'),
                 (DATA/'receipt.schema.json','receipt_schema_sha256')]
        for path,key in paths:
            if digest(path.read_bytes()) != pins[key]: raise EvaluationError()
        ref=json.loads(paths[0][0].read_bytes())
        if ref['schema_version'] != 1 or not ref['review']['independent_of_candidates']: raise EvaluationError()
        return ref,pins
    except Exception:
        pass
    raise EvaluationError()
def compile_case(case, *, expected_scope=None):
    """Byte spans come from authored quotations in pinned synthetic source, not candidate text."""
    scope={'request_id':'00000000-0000-4000-8000-000000000001',
           'source_ref':'00000000-0000-4000-8000-000000000002','scope_token':'a'*64}
    if expected_scope is not None:
        from summary_contracts.validation import validate_summary_structure
        if not validate_summary_structure('Scope',expected_scope):raise EvaluationError()
        scope=copy.deepcopy(expected_scope)
    text=case['text']; facts=[]
    def ev(quote,base=0,within=None):
        region=text if within is None else within
        if region.count(quote)!=1: raise EvaluationError()
        start=base+region.index(quote)
        return {'source_ref':scope['source_ref'],'start_byte':len(text[:start].encode()),
                'end_byte':len(text[:start+len(quote)].encode()),'quote':quote,'page':None}
    for item in case['facts']:
        quote=item['quote']; parent=ev(quote); measurement=None
        if item['measurement'] is not None:
            annotation=item['measurement']; base=text.index(quote)
            def quoted(value,key): return None if value is None else {key:value,'evidence':ev(value,base,quote)}
            measurement={k:quoted(annotation[k],'text' if k in ('label','unit','reported_range') else 'decimal' if k=='value' else 'symbol') for k in ('label','value','unit','operator','reported_range')}
            flag=annotation['flag']
            measurement['reported_flag']=None if flag is None else {'value':{'H':'high','L':'low','N':'normal'}[flag],'evidence':ev(flag,base,quote)}
        facts.append({'id':item['id'],'kind':item['kind'],'evidence':parent,'certainty':item['certainty'],
                      'polarity':item['polarity'],'required':False,'conflict_group':item['conflict_group'],
                      'term_ids':item['terms'],'measurement':measurement})
    source={'schema_version':1,'kind':'medical-summary-input','scope':scope,
            'source':{'text':text,'text_sha256':digest(text.encode()),'original_sha256':digest(('synthetic-original:'+case['id']).encode()),
                      'metadata_sha256':digest(('synthetic-metadata:'+case['id']).encode()),'processing_attempt':1,
                      'extraction_status':'completed','method':case['method'],'page_count':2 if case['method']=='mixed' else 1},'facts':facts}
    context={**scope,'input_sha256':summary_input_digest(source)}
    return source,context,expected_recipe(context['input_sha256'])
def gold_metadata(case, selected):
    """Independent reference rule, intentionally does not import expected_metadata."""
    codes={'page_locations_unavailable'}; ids=set(); terms=set()
    if case['method']!='pdf_text':codes.add('ocr_used');terms.add('ocr')
    if len(selected)<len(case['facts']):codes.add('limited_coverage')
    for fact in case['facts']:
        if fact['id'] not in selected: continue
        terms.update(fact['terms'])
        if fact['certainty']=='ambiguous':codes.add('ambiguous_source');ids.add(fact['id'])
        if fact['conflict_group']:codes.add('conflicting_findings');ids.add(fact['id'])
        m=fact['measurement']
        if m and m['value'] is None:codes.add('missing_measurement_value');ids.add(fact['id'])
        if m and m['unit'] is None:codes.add('missing_unit');ids.add(fact['id'])
    return {'codes':sorted(codes),'fact_ids':sorted(ids)},sorted(terms)
