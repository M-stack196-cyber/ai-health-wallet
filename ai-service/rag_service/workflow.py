"""Bounded LangGraph. Node authorizes and retrieves; graph cannot widen its evidence."""
import os
os.environ['LANGSMITH_TRACING']='false'
os.environ['LANGCHAIN_TRACING_V2']='false'
import copy
import re
from typing import TypedDict
from langchain_core.documents import Document
from langgraph.graph import StateGraph,START,END
from .components import AuthorizedEvidenceRetriever

INSUFFICIENT='The available health records do not contain enough information to answer this question.'
POLICY='patient-records-rag-v1'
PROVIDER={'provider':'synthetic-offline','model':'exact-evidence-selector','revision':'1','policy':POLICY}

# M08-007: symptom questions get a fixed, non-diagnostic notice. Node repeats this check and must agree.
SAFETY_NOTICE='non_diagnostic_v1'
SYMPTOM=re.compile(r'\b(symptom\w*|pain\w*|aches?|aching|fever\w*|cough\w*|nausea\w*|vomit\w*|dizz\w*|headache\w*|rash\w*|swell\w*|bleed\w*|breath\w*|fatigue\w*|hurt\w*)\b',re.I)
def symptom_related(question):return bool(SYMPTOM.search(question))

STOP_WORDS={'what','which','where','when','who','whom','whose','why','how','the','and','for','are','was','were','is','am','be','been','being','have','has','had','do','does','did','will','would','shall','should','can','could','may','might','must','show','tell','give','list','find','get','fetch','read','check','see','view','my','me','mine','our','ours','your','yours','his','her','hers','their','theirs','this','that','these','those','from','with','about','into','onto','upon','over','under','between','level','levels','value','values','result','results','test','tests','report','reports','record','records','normal','range','ranges','please','kindly','or','of','in','on','at','to','by','as','an','a'}

ABBREV_MAP={
    'hb':'hemoglobin','hgb':'hemoglobin','haemoglobin':'hemoglobin',
    'hct':'hematocrit','haematocrit':'hematocrit','pcv':'hematocrit',
    'wbc':'wbc','tlc':'wbc','leukocytes':'wbc','leucocytes':'wbc',
    'rbc':'rbc','erythrocytes':'rbc',
    'plt':'platelets','platelet':'platelets','platelets':'platelets',
    'creat':'creatinine','creatinine':'creatinine',
    'na':'sodium','sodium':'sodium',
    'k':'potassium','potassium':'potassium',
    'cl':'chloride','chloride':'chloride',
    'fbs':'glucose','rbs':'glucose','glucose':'glucose','sugar':'glucose'
}

def fuzzy_contains(haystack, needle):
    if not needle:
        return False
    if needle in haystack:
        return True
    if len(needle) < 5:
        return False
    for w in [w for w in re.split(r'[^a-z0-9]+', haystack) if len(w) >= 4]:
        if abs(len(w) - len(needle)) > 2:
            continue
        if w[:4] == needle[:4]:
            diffs = 0
            i = j = 0
            while i < len(w) and j < len(needle):
                if w[i] == needle[j]:
                    i += 1
                    j += 1
                else:
                    diffs += 1
                    if diffs > 2:
                        break
                    if len(w) > len(needle):
                        i += 1
                    elif len(needle) > len(w):
                        j += 1
                    else:
                        i += 1
                        j += 1
            diffs += (len(w) - i) + (len(needle) - j)
            if diffs <= 2:
                return True
    return False

def extract_query_keywords(question):
    raw = [w for w in re.split(r'[^a-z0-9]+', question.lower()) if w]
    out = []
    for w in raw:
        if w in ABBREV_MAP:
            out.append(ABBREV_MAP[w])
        elif len(w) >= 2 and w not in STOP_WORDS:
            out.append(w)
    return list(dict.fromkeys(out))

def topic(question):
    if re.search(r'\b(diagnos\w*|prescrib\w*|treatment|medication|symptom\w*|system|prompt|secret|ignore|exfiltrat\w*)\b',question,re.I):return None
    if re.search(r'\b(all|every|full|complete|entire)\b.*\b(results?|tests?|values?|reports?|records?|labs?|parameters?)\b|\b(what|show|list|give)\b.*\b(my\s+(?:lab\s+|medical\s+|health\s+)?(?:results?|tests?|reports?|records?|values?))\b',question,re.I):return 'all_measurements'
    if re.search(r'\b(glucose|sugar|fbs|rbs)\b',question,re.I):return 'glucose'
    if re.search(r'\b(hemoglobin|haemoglobin|hgb|hb)\b',question,re.I):return 'hemoglobin'
    if re.search(r'\b(hematocrit|haematocrit|hct|pcv)\b',question,re.I):return 'hematocrit'
    if re.search(r'\b(wbc|tlc|white\s+blood\s+cells?|leukocytes?|leucocytes?)\b',question,re.I):return 'wbc'
    if re.search(r'\b(rbc|red\s+blood\s+cells?|erythrocytes?)\b',question,re.I):return 'rbc'
    if re.search(r'\b(platelets?|plt)\b',question,re.I):return 'platelets'
    if re.search(r'\b(creatinine|creat)\b',question,re.I):return 'creatinine'
    if re.search(r'\b(sodium|na)\b',question,re.I):return 'sodium'
    if re.search(r'\b(potassium|k)\b',question,re.I):return 'potassium'
    if re.search(r'\b(chloride|cl)\b',question,re.I):return 'chloride'
    if re.search(r'\belectrolytes?\b',question,re.I):return 'electrolytes'
    if re.search(r'\b(cbc|fbc|complete\s+blood\s+count|blood\s+count)\b',question,re.I):return 'cbc'
    return 'keyword_match'

def matches_topic(wanted, f, question, doc_context=''):
    tid = f.get('topic')
    if wanted == 'all_measurements': return True
    if wanted == 'electrolytes': return tid in ('sodium', 'potassium', 'chloride')
    if wanted == 'cbc': return tid in ('hemoglobin', 'hematocrit', 'wbc', 'rbc', 'platelets')
    if wanted == 'keyword_match':
        if tid == 'document_text':
            return True
        label = (f.get('label') or '').lower()
        keywords = extract_query_keywords(question)
        if not keywords:
            return True
        if any(w in label or w in (tid or '') or fuzzy_contains(label, w) for w in keywords):
            return True
        if doc_context and any(fuzzy_contains(doc_context, w) for w in keywords):
            return True
        return False
    return tid == wanted

class SyntheticAnswerProvider:
    async def generate(self,facts):return [f['citation_id'] for f in facts]

class State(TypedDict,total=False):
    authorized:bool
    question:str
    records:list
    docs:list
    facts:list
    selected:list
    status:str

def build_graph(provider=None,retriever_factory=None):
    provider=provider if provider is not None else SyntheticAnswerProvider()
    async def authorize(s):return {'status':'ready' if s.get('authorized') is True else 'unauthorized'}
    async def retrieve(s):
        try:
            retriever=(retriever_factory(s['records']) if retriever_factory else AuthorizedEvidenceRetriever(evidence=[Document(page_content=r['text'],metadata={'facts':r['facts'],'doc_context':((r.get('document_name') or '')+'\n'+(r.get('text') or '')).lower()}) for r in s['records']]))
            docs=retriever.invoke(s['question'],config={'callbacks':[]})
            return {'docs':docs,'status':'ready' if docs else 'no_records'}
        except Exception:return {'status':'retrieval_failed'}
    async def assess(s):
        wanted=topic(s['question'])
        facts=[f for d in s['docs'] for f in d.metadata['facts'] if matches_topic(wanted, f, s['question'], d.metadata.get('doc_context',''))] if wanted else []
        # Duplicate/overlap citations are removed without merging different sources.
        facts=list({f['citation_id']:f for f in facts}.values())
        return {'facts':facts,'status':'ready' if facts else 'insufficient'}
    async def context(s):return {'facts':copy.deepcopy(s['facts'])}
    async def generate(s):
        try:return {'selected':await provider.generate(copy.deepcopy(s['facts'])),'status':'ready'}
        except Exception:return {'status':'provider_failed'}
    async def validate(s):
        expected=[f['citation_id'] for f in s['facts']]
        return {'status':'answered' if s['selected']==expected else 'safety_failed'}
    g=StateGraph(State)
    for name,node in [('authorize',authorize),('retrieve',retrieve),('assess',assess),('context',context),('generate',generate),('validate',validate)]:g.add_node(name,node)
    g.add_edge(START,'authorize')
    for name,next_node in [('authorize','retrieve'),('retrieve','assess'),('assess','context'),('generate','validate')]:
        g.add_conditional_edges(name,lambda s:'next' if s['status']=='ready' else 'stop',{'next':next_node,'stop':END})
    g.add_edge('context','generate');g.add_edge('validate',END)
    return g.compile()

async def answer(question,records,authorized=True,provider=None,retriever_factory=None,allowed_document_ids=None):
    # Defence in depth for doctor grants: Node declares the permitted documents and every evidence record must carry one of them.
    if allowed_document_ids is not None:
        allowed=set(allowed_document_ids)
        authorized=authorized and all(type(r.get('document_id')) is str and r['document_id'] in allowed for r in records)
    state=await build_graph(provider,retriever_factory).ainvoke({'authorized':authorized,'question':question,'records':records},config={'callbacks':[],'recursion_limit':12})
    return {'status':state['status'],'selected':state.get('selected',[]) if state['status']=='answered' else [],'provenance':PROVIDER,
            'safety_notice':SAFETY_NOTICE if symptom_related(question) else None}
