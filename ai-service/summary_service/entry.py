"""Explicit offline/synthetic service only; no hosted provider or implicit credentials."""
import os
import uvicorn
from .app import ServiceConfig, create_app
from .provider import DeterministicFakeProvider

def main():
    mode=os.environ.get('SUMMARY_PROVIDER','disabled')
    if mode!='synthetic-offline':
        raise ValueError('SUMMARY_PROVIDER_NOT_APPROVED')
    port=int(os.environ.get('SUMMARY_SERVICE_PORT','8012'))
    if not 1024<=port<=65535:raise ValueError('INVALID_SUMMARY_PORT')
    app=create_app(ServiceConfig(enabled=True,token=os.environ.get('SUMMARY_SERVICE_TOKEN')),provider=DeterministicFakeProvider())
    uvicorn.run(app,host='127.0.0.1',port=port,access_log=False,log_level='critical')
if __name__=='__main__':main()
