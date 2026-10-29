import asyncio
import base64
import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4
import httpx
from PIL import Image, ImageDraw, ImageFont
from ocr_service.app import Config, create_app

TOKEN = '1a2b3c4d' * 8

def request(content, media='image/png'):
    document = str(uuid4())
    return dict(schema_version=1,request_id=str(uuid4()),document_id=document,job_id=document,attempt=1,
                fence_token=str(uuid4()),media_type=media,source_sha256=hashlib.sha256(content).hexdigest(),
                content_base64=base64.b64encode(content).decode(),mode='native_or_ocr')

def image(format='PNG'):
    im=Image.new('RGB',(1000,300),'white')
    draw=ImageDraw.Draw(im)
    font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',40)
    draw.text((40,40),'SYNTHETIC GLUCOSE 90 mg/dL',fill='black',font=font)
    draw.text((40,130),'REPORT 2026-02-03',fill='black',font=font)
    out=io.BytesIO();im.save(out,format=format)
    return out.getvalue()

class OcrTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(Config(token=TOKEN))),base_url='http://private')
        self.headers={'Authorization':'Bearer '+TOKEN}
    async def asyncTearDown(self):
        await self.client.aclose()
    async def test_health_and_auth(self):
        self.assertEqual((await self.client.get('/health')).status_code,401)
        self.assertTrue((await self.client.get('/ready',headers=self.headers)).json()['ready'])
    async def test_request_boundary_no_paths_or_patient_auth(self):
        for body in [{}, {'path':'/etc/passwd'},{'url':'https://example.invalid'}]:
            r=await self.client.post('/v1/extractions',json=body,headers=self.headers)
            self.assertEqual(r.status_code,422);self.assertEqual(r.json()['error']['code'],'INVALID_REQUEST')
            self.assertNotIn('/etc/',r.text)
    async def test_hash_and_identity_binding(self):
        body=request(image());body['source_sha256']='0'*64
        self.assertEqual((await self.client.post('/v1/extractions',json=body,headers=self.headers)).json()['ok'],False)
        body=request(image());body['job_id']=str(uuid4())
        self.assertEqual((await self.client.post('/v1/extractions',json=body,headers=self.headers)).status_code,422)
    async def test_png_jpeg_real_ocr_structured_provenance(self):
        for format,mime in [('PNG','image/png'),('JPEG','image/jpeg')]:
            body=request(image(format),mime);r=await self.client.post('/v1/extractions',json=body,headers=self.headers)
            self.assertEqual(r.status_code,200)
            result=r.json();self.assertTrue(result['ok']);self.assertEqual(result['request_id'],body['request_id'])
            self.assertIn('GLUCOSE',result['extraction']['text'])
            self.assertEqual(result['extraction']['source']['sha256'],body['source_sha256'])
            self.assertEqual(result['structured']['content_trust'],'untrusted_document_data')
            self.assertTrue(result['structured']['pages'][0]['fragments'][0]['region'])
    async def test_malformed_supported_media_is_structured_failure(self):
        for media in ['application/pdf','image/png','image/jpeg']:
            r=await self.client.post('/v1/extractions',json=request(b'invalid content',media),headers=self.headers)
            self.assertEqual(r.status_code,422);self.assertFalse(r.json()['ok']);self.assertNotIn('invalid content',r.text)
    async def test_deadline_cancels_work_and_removes_temporary_input(self):
        import ocr_service.app as module
        original=module.extract;entered=asyncio.Event();cancelled=asyncio.Event()
        async def blocked(*args):
            entered.set()
            try:await asyncio.sleep(60)
            finally:cancelled.set()
        module.extract=blocked
        try:
            app=create_app(Config(token=TOKEN,deadline_seconds=0.1))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://private') as client:
                r=await client.post('/v1/extractions',json=request(image()),headers=self.headers)
                self.assertEqual(r.status_code,504);self.assertTrue(entered.is_set());self.assertTrue(cancelled.is_set())
        finally:module.extract=original
    def test_configuration_no_implicit_token(self):
        with self.assertRaises(ValueError):Config(token='')
    async def test_busy_and_cancellation_release_admission(self):
        import ocr_service.app as module
        original=module.extract;entered=asyncio.Event();cancelled=asyncio.Event()
        async def blocked(*args):
            entered.set()
            try:await asyncio.sleep(60)
            finally:cancelled.set()
        module.extract=blocked
        try:
            first=asyncio.create_task(self.client.post('/v1/extractions',json=request(image()),headers=self.headers))
            await asyncio.wait_for(entered.wait(),10)
            second=await self.client.post('/v1/extractions',json=request(image()),headers=self.headers)
            self.assertEqual(second.status_code,503);self.assertEqual(second.json()['error']['code'],'BUSY')
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):await first
            await asyncio.wait_for(cancelled.wait(),10)
        finally:
            first.cancel()
            await asyncio.gather(first,return_exceptions=True)
            module.extract=original
        self.assertEqual((await self.client.post('/v1/extractions',json=request(image()),headers=self.headers)).status_code,200)
    async def test_size_limit_and_boolean_version_are_rejected(self):
        body=request(image());body['schema_version']=True
        self.assertEqual((await self.client.post('/v1/extractions',json=body,headers=self.headers)).status_code,422)
        small=create_app(Config(token=TOKEN,max_bytes=1024))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=small),base_url='http://private') as client:
            r=await client.post('/v1/extractions',json=request(b'x'*2048),headers=self.headers)
            self.assertEqual(r.status_code,422);self.assertFalse(r.json()['ok'])
