"""Private bounded factory; accepts only Node-scoped data, not patient credentials."""
import asyncio
import hashlib
import hmac
import json
import re
from fastapi import FastAPI,Request
from starlette.responses import JSONResponse
from .components import chunks,SyntheticEmbeddings,MODEL
from .workflow import answer

def create_app(token):
    if not isinstance(token,str) or not re.fullmatch('[a-f0-9]{64}',token):raise ValueError('INVALID_RAG_CONFIGURATION')
    app=FastAPI(docs_url=None,redoc_url=None,openapi_url=None,debug=False)
    active=0
    def reply(value,status=200):return JSONResponse(value,status_code=status,headers={'Cache-Control':'no-store'})
    @app.middleware('http')
    async def authorize(request,call_next):
        auth=request.headers.get('authorization','')
        if len(auth)>256 or not hmac.compare_digest(hashlib.sha256(auth.encode()).digest(),hashlib.sha256(('Bearer '+token).encode()).digest()):return reply({'error':'UNAUTHORIZED'},401)
        if request.url.query:return reply({'error':'INVALID_REQUEST'},400)
        return await call_next(request)
    @app.get('/health')
    async def health():return reply({'schema_version':1,'ready':True,'mode':'synthetic-offline'})
    @app.post('/internal/v1/rag/{operation}')
    async def process(operation:str,request:Request):
        nonlocal active
        if active:return reply({'error':'BUSY'},503)
        active+=1
        try:
            async with asyncio.timeout(5):
                body=bytearray()
                async for part in request.stream():
                    body.extend(part)
                    if len(body)>262144:raise ValueError()
                data=json.loads(body)
                if type(data) is not dict or data.get('schema_version')!=1 or type(data.get('schema_version')) is not int or not re.fullmatch('[a-f0-9-]{36}',data.get('request_id','')):raise ValueError()
                if operation=='chunks' and set(data)=={'schema_version','request_id','text','pages'}:result=chunks(data['text'],data['pages'])
                elif operation=='embedding' and set(data)=={'schema_version','request_id','question'} and isinstance(data['question'],str) and 0<len(data['question'].encode())<=1000:result={'model':MODEL,'embedding':SyntheticEmbeddings().embed_query(data['question'])}
                elif operation=='answers' and set(data)=={'schema_version','request_id','question','context_json','context_sha256'}:
                    if not isinstance(data['question'],str) or not 0<len(data['question'].encode())<=1000 or not isinstance(data['context_json'],str) or hashlib.sha256(data['context_json'].encode()).hexdigest()!=data['context_sha256']:raise ValueError()
                    records=json.loads(data['context_json'])
                    if type(records) is not list or len(records)>20:raise ValueError()
                    result=await answer(data['question'],records)
                    result['context_sha256']=data['context_sha256']
                else:raise ValueError()
                return reply({'schema_version':1,'request_id':data['request_id'],**result})
        except TimeoutError:return reply({'error':'TIMEOUT'},504)
        except Exception:return reply({'error':'INVALID_REQUEST'},422)
        finally:active-=1
    return app
