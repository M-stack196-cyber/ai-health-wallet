"""Test-only Node/ASGI bridge. Accepts only known golden synthetic fixture bodies."""
import asyncio,json,socket,sys
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'ai-service'))
import httpx
from summary_service.app import create_app,ServiceConfig
from summary_service.provider import DeterministicFakeProvider
from summary_service.protocol import PATH
from summary_contracts.validation import canonical_summary_json

async def main():
    request=json.loads(sys.stdin.buffer.read(300000))
    known=json.loads((ROOT/'shared/medical-summary/fixtures.json').read_text())['cases']
    if not any(c['expected']=='OK' and request['body']==canonical_summary_json(c['input']) for c in known):
        raise ValueError('SYNTHETIC_FIXTURE_REQUIRED')
    app=create_app(ServiceConfig(enabled=True,token='a'*64),provider=DeterministicFakeProvider())
    with patch.object(socket.socket,'connect',side_effect=AssertionError('NETWORK_FORBIDDEN')):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://synthetic.invalid') as client:
            result=await client.post(PATH,content=request['body'].encode(),headers=request['headers'])
    print(json.dumps({'status':result.status_code,'body':result.text}))
if __name__=='__main__':
    try:asyncio.run(main())
    except Exception:raise SystemExit('SYNTHETIC_BRIDGE_FAILURE') from None
