"""LangChain components with no network/model credentials or persistence capability."""
import hashlib
import math
import re
from langchain_core.documents import Document
from langchain_core.embeddings import Embeddings
from langchain_core.retrievers import BaseRetriever
from langchain_text_splitters import RecursiveCharacterTextSplitter

MODEL={'key':'synthetic-hash-32-v1','provider':'local-synthetic','model':'hash-token','revision':'1','dimensions':32}
CHUNKER='lc-recursive-600-80-v1'

class SyntheticEmbeddings(Embeddings):
    def embed_documents(self,texts):return [self.embed_query(text) for text in texts]
    def embed_query(self,text):
        values=[0.0]*32
        for term in re.findall(r'[a-z0-9]+',text.lower()):
            slot=int.from_bytes(hashlib.sha256(term.encode()).digest()[:4],'big')%32
            values[slot]+=1
        if not any(values):values[0]=1
        norm=math.sqrt(sum(v*v for v in values));return [v/norm for v in values]

def chunks(text,pages):
    if not isinstance(text,str) or not 0<len(text.encode())<=32768:raise ValueError('INVALID_SOURCE')
    if pages is not None and ('\n\n'.join(p['text'] for p in pages)!=text or [p['page'] for p in pages]!=list(range(1,len(pages)+1))):raise ValueError('INVALID_PAGES')
    splitter=RecursiveCharacterTextSplitter(chunk_size=600,chunk_overlap=80,add_start_index=True,separators=['\n\n','\n',' ',''])
    sources=pages if pages is not None else [{'page':None,'text':text}]
    result=[];base=0
    for page in sources:
        for doc in splitter.create_documents([page['text']]):
            start=base+len(page['text'][:doc.metadata['start_index']].encode())
            result.append({'order':len(result),'start_byte':start,'end_byte':start+len(doc.page_content.encode()),'text':doc.page_content,'page':page['page']})
        base+=len(page['text'].encode())+2
    if not result or len(result)>128:raise ValueError('SOURCE_LIMIT')
    vectors=SyntheticEmbeddings().embed_documents([r['text'] for r in result])
    return {'chunker':CHUNKER,'model':MODEL,'source_sha256':hashlib.sha256(text.encode()).hexdigest(),'chunks':[{**r,'embedding':v} for r,v in zip(result,vectors)]}

class AuthorizedEvidenceRetriever(BaseRetriever):
    """Only Node's already scoped SQL evidence can enter this port; no DB access."""
    evidence:list[Document]
    def _get_relevant_documents(self,query,*,run_manager):
        return list(self.evidence)
