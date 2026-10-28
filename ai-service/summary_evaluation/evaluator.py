"""Three independent evaluation layers; privacy-safe results, no textual similarity scores."""
import copy
from summary_contracts.validation import (validate_summary_structure, validate_summary_output,
    validate_summary_input, canonical_summary_json, SummaryValidationError)
from .reference import compile_case, gold_metadata
VERSION='medical-summary-evaluator-v1'
METRICS=('unsupported_facts','unsupported_interpretations','fabricated_diagnoses','treatment_instructions','numerical_errors','unit_errors',
         'operator_errors','range_flag_errors','negation_errors','citation_errors',
         'uncertainty_errors','glossary_errors','provenance_errors','scope_errors')
def evaluate(case, candidate, source=None, context=None, recipe=None, *, expected_scope=None, expected_provenance=None):
    gold,authority,expected_recipe=compile_case(case,expected_scope=expected_scope)
    if expected_provenance is not None:
        from .reference import EvaluationError
        if not validate_summary_structure('SummaryProvenanceV1',expected_provenance) or expected_provenance['input_sha256']!=authority['input_sha256']:raise EvaluationError()
        expected_recipe=copy.deepcopy(expected_provenance)
    source=copy.deepcopy(gold if source is None else source)
    context=copy.deepcopy(authority if context is None else context)
    recipe=copy.deepcopy(expected_recipe if recipe is None else recipe)
    schema_valid=bool(validate_summary_structure('SummaryOutputV1',candidate))
    grounding_valid=False
    try:
        validate_summary_output(candidate,source,context,recipe);grounding_valid=True
    except SummaryValidationError: pass
    errors={k:0 for k in METRICS}
    out=candidate if type(candidate) is dict else {}
    raw=out.get('reported_findings',[])
    findings=raw if type(raw) is list else []
    refs={f['id']:f for f in gold['facts']}; seen=set(); covered=set()
    for f in findings:
        if type(f) is dict and f.get('kind')=='reported_diagnosis' and (type(f.get('id')) is not str or f.get('id') not in refs or f!=refs.get(f.get('id'))):errors['fabricated_diagnoses']+=1
        if type(f) is dict and type(f.get('evidence')) is dict and f['evidence'].get('source_ref')!=gold['scope']['source_ref']:errors['scope_errors']+=1
        if type(f) is not dict or type(f.get('id')) is not str or f['id'] not in refs or f['id'] in seen:
            errors['unsupported_facts']+=1;continue
        seen.add(f['id']); g=refs[f['id']]
        if f==g:covered.add(f['id'])
        if f.get('kind')!=g['kind'] or set(f)!=set(g):errors['unsupported_interpretations']+=1
        if f.get('polarity')!=g['polarity']:errors['negation_errors']+=1
        if f.get('evidence')!=g['evidence']:errors['citation_errors']+=1
        if f.get('certainty')!=g['certainty'] or f.get('conflict_group')!=g['conflict_group']:errors['uncertainty_errors']+=1
        m=f.get('measurement');gm=g['measurement']
        if (m is None)!=(gm is None) or (m is not None and type(m) is not dict):errors['numerical_errors']+=1
        elif m is not None:
            for field,metric in [('value','numerical_errors'),('label','numerical_errors'),('unit','unit_errors'),('operator','operator_errors'),('reported_range','range_flag_errors'),('reported_flag','range_flag_errors')]:
                if m.get(field)!=gm[field]:errors[metric]+=1
    allowed={'schema_version','kind','scope','reported_findings','educational_explanations','uncertainty','catalogue_coverage','provenance'}
    errors['unsupported_interpretations']+=len(set(out)-allowed)
    if 'treatment_instructions' in out:errors['treatment_instructions']+=1
    if 'patient_id' in out:errors['scope_errors']+=1
    if out.get('scope')!=gold['scope'] or source.get('scope')!=gold['scope'] or context!=authority:errors['scope_errors']+=1
    if out.get('provenance')!=expected_recipe or source!=gold or recipe!=expected_recipe:errors['provenance_errors']+=1
    uncertainty,terms=gold_metadata(case,seen)
    if out.get('uncertainty')!=uncertainty:errors['uncertainty_errors']+=1
    if out.get('educational_explanations')!=terms:errors['glossary_errors']+=1
    critical={f['id'] for f in case['facts'] if f['critical']}
    missing_critical=len(critical-covered)
    semantic_valid=not any(errors.values()) and missing_critical==0 and len(covered)==len(refs)
    return {'schema_valid':schema_valid,'grounding_valid':grounding_valid,'semantic_valid':semantic_valid,
            'accepted':schema_valid and grounding_valid and semantic_valid,
            'coverage':{'reference_facts':len(refs),'covered_facts':len(covered),'critical_facts':len(critical),
                        'covered_critical_facts':len(critical&covered),'missing_critical_facts':missing_critical},
            'errors':errors}
