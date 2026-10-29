import os
import uvicorn
from .app import create_app

def main():
    if os.environ.get('RAG_PROVIDER')!='synthetic-offline':raise ValueError('RAG_PROVIDER_NOT_APPROVED')
    port=int(os.environ.get('RAG_SERVICE_PORT','8013'))
    if not 1024<=port<=65535:raise ValueError('INVALID_RAG_CONFIGURATION')
    uvicorn.run(create_app(os.environ.get('RAG_SERVICE_TOKEN')),host='127.0.0.1',port=port,access_log=False,log_level='critical')
if __name__=='__main__':main()
