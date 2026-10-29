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

def topic(question):
    if re.search(r'\b(diagnos\w*|prescrib\w*|treatment|medication|symptom\w*|system|prompt|secret|ignore|exfiltrat\w*)\b',question,re.I):return None
    if re.search(r'\bglucose\b',question,re.I):return 'glucose'
    if re.search(r'\b(hemoglobin|haemoglobin|hgb|hb)\b',question,re.I):return 'hemoglobin'
    return None

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
            retriever=(retriever_factory(s['records']) if retriever_factory else AuthorizedEvidenceRetriever(evidence=[Document(page_content=r['text'],metadata={'facts':r['facts']}) for r in s['records']]))
            docs=retriever.invoke(s['question'],config={'callbacks':[]})
            return {'docs':docs,'status':'ready' if docs else 'no_records'}
        except Exception:return {'status':'retrieval_failed'}
    async def assess(s):
        wanted=topic(s['question'])
        facts=[f for d in s['docs'] for f in d.metadata['facts'] if f['topic']==wanted] if wanted else []
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

async def answer(question,records,authorized=True,provider=None,retriever_factory=None):
    state=await build_graph(provider,retriever_factory).ainvoke({'authorized':authorized,'question':question,'records':records},config={'callbacks':[],'recursion_limit':12})
    return {'status':state['status'],'selected':state.get('selected',[]) if state['status']=='answered' else [],'provenance':PROVIDER}
