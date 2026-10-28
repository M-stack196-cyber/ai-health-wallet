"""Fixed red-team mutations. Expected decisions are authored independently of candidates."""
import copy
from summary_contracts.validation import summary_input_digest
from .reference import gold_metadata
# (fixture, mutation, expected acceptance). Never learns gold from evaluated output.
import json
from .reference import DATA
SCENARIOS=[(s['case'],s['mutation'],s['expected_acceptance']) for s in json.loads((DATA/'scenarios-v1.json').read_bytes())['scenarios']]
def mutate(name,case,candidate,source,context,recipe):
    out=copy.deepcopy(candidate);source=copy.deepcopy(source);context=copy.deepcopy(context);recipe=copy.deepcopy(recipe)
    f=out['reported_findings'][0] if out['reported_findings'] else None
    if name=='decimal':f['measurement']['value']['decimal']='6.50'
    elif name=='precision':f['measurement']['value']['decimal']='5.5'
    elif name=='unit':f['measurement']['unit']['text']='mg/dL'
    elif name=='operator':f['measurement']['operator']['symbol']='>'
    elif name=='range':f['measurement']['reported_range']['text']='0–100'
    elif name=='flag':f['measurement']['reported_flag']['value']='normal'
    elif name=='offset':f['evidence']['end_byte']-=1
    elif name=='utf16':f['evidence']['start_byte']=len(case['text'][:case['text'].index(case['facts'][0]['quote'])].encode('utf-16-le'))//2
    elif name=='quote':f['evidence']['quote']='unreported statement'
    elif name=='page':f['evidence']['page']=1
    elif name in ('source_hash','original_hash','metadata_hash','attempt','input_limit','incomplete'):
        key={'source_hash':'text_sha256','original_hash':'original_sha256','metadata_hash':'metadata_sha256','attempt':'processing_attempt','input_limit':'text','incomplete':'extraction_status'}[name]
        source['source'][key]=2 if name=='attempt' else 'X'*32769 if name=='input_limit' else 'incomplete' if name=='incomplete' else '0'*64
    elif name=='provenance':out['provenance']['model_revision']='unapproved'
    elif name=='scope':out['scope']['scope_token']='b'*64
    elif name=='foreign_evidence':f['evidence']['source_ref']='00000000-0000-4000-8000-000000000099'
    elif name in ('diagnosis','injection'):
        unknown=copy.deepcopy(f);unknown['id']='F999';unknown['kind']='reported_diagnosis';unknown['evidence']['quote']='New diagnosis not reported';out['reported_findings'].append(unknown)
    elif name=='treatment':out['treatment_instructions']='Start unreported medication'
    elif name=='glossary':out['educational_explanations']=['unreviewed-explanation']
    elif name=='unknown_field':out['patient_id']='synthetic-forbidden-identifier'
    elif name=='negation':f['polarity']='affirmed'
    elif name=='ambiguity':f['certainty']='explicit'
    elif name=='invented_unit':f['measurement']['unit']={'text':'mg/L','evidence':copy.deepcopy(f['evidence'])}
    elif name in ('omission','catalogue_gap','conflict'):
        out['reported_findings']=out['reported_findings'][1:]
        selected={f['id'] for f in out['reported_findings']}
        out['uncertainty'],out['educational_explanations']=gold_metadata(case,selected)
        out['catalogue_coverage']='subset'
        if name=='catalogue_gap':
            source['facts']=source['facts'][1:];context['input_sha256']=summary_input_digest(source)
            recipe['input_sha256']=context['input_sha256'];out['provenance']['input_sha256']=context['input_sha256']
            out['catalogue_coverage']='all_catalogued';out['uncertainty']['codes'].remove('limited_coverage')
    else: raise ValueError('Unknown offline scenario')
    return out,source,context,recipe
