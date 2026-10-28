"""Private application factory. No environment/credential loading or access logging."""
from __future__ import annotations
import asyncio
import hashlib
import hmac
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from fastapi import FastAPI, Request
from starlette.exceptions import HTTPException
from starlette.responses import Response
from summary_contracts.validation import SummaryValidationError, LIMITS, parse_summary_json
from .protocol import PATH, CONTEXT_HEADERS
from .provider import ModelProvider
from .workflow import generate_summary

@dataclass(frozen=True, repr=False)
class ServiceConfig:
    enabled: bool = False
    token: str | None = field(default=None, repr=False)
    concurrency: int = 1
    deadline_seconds: float = 2.0
    drain_seconds: float = 0.1

    def __post_init__(self):
        valid = (type(self.enabled) is bool and type(self.concurrency) is int
                 and 1 <= self.concurrency <= 4
                 and type(self.deadline_seconds) in (int, float) and 0.01 <= self.deadline_seconds <= 10
                 and type(self.drain_seconds) in (int, float) and 0.01 <= self.drain_seconds <= 1)
        if self.enabled or self.token is not None:
            valid = valid and type(self.token) is str and re.fullmatch(r'[0-9a-f]{64}', self.token) is not None
        if not valid:
            raise ValueError('INVALID_SERVICE_CONFIG')

class Refusal(Exception):
    def __init__(self, code, status):
        self.code, self.status = code, status
        super().__init__(code)

def failure(code, status):
    # Fixed codes only. No paths, headers, exceptions, inputs or identifiers.
    return Response('{"schema_version":1,"error":{"code":"' + code + '"}}',
                    status_code=status, media_type='application/json',
                    headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

def cancel_once(task):
    if not task.done() and not task.cancelling():
        task.cancel()

def consume(task):
    if not task.cancelled():
        task.exception()  # Retrieve errors without logging task payloads/tracebacks.

def create_app(config: ServiceConfig | None = None, *, provider: ModelProvider | None = None) -> FastAPI:
    config = config if config is not None else ServiceConfig()
    if type(config) is not ServiceConfig or (config.enabled and provider is None):
        raise ValueError('INVALID_SERVICE_CONFIG')
    active: set[asyncio.Task] = set()
    admitted = 0
    requests: set[asyncio.Task] = set()
    closing = False
    expected_auth = hashlib.sha256(('Bearer ' + (config.token or '')).encode()).digest()

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal closing
        try:
            yield
        finally:
            closing = True
            pending = active | requests
            for task in tuple(pending):
                cancel_once(task)
            if pending:
                await asyncio.wait(tuple(pending), timeout=config.drain_seconds)
        # Non-cooperative code cannot be force-killed in Python. Capacity is retained
        # until it exits; production provider isolation requires a later approval.

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, debug=False,
                  lifespan=lifespan, redirect_slashes=False,
                  telemetry={'tracing': False, 'metrics': False, 'logs': False,
                             'operation_spans': False, 'auto_configure': False})

    @app.exception_handler(HTTPException)
    async def http_failure(_request, exc):
        return failure('NOT_FOUND' if exc.status_code == 404 else 'METHOD_NOT_ALLOWED', exc.status_code)

    @app.exception_handler(Exception)
    async def generic_failure(_request, _exc):
        return failure('SERVICE_FAILURE', 500)

    @app.post(PATH)
    async def generate(request: Request):
        nonlocal admitted
        if not config.enabled or closing:
            return failure('SERVICE_DISABLED', 503)
        headers = request.scope['headers']
        def values(name):
            return [v for k, v in headers if k.lower() == name.encode()]
        auth = values('authorization')
        supplied = auth[0] if len(auth) == 1 and len(auth[0]) <= 512 else b''
        if not hmac.compare_digest(hashlib.sha256(supplied).digest(), expected_auth):
            return failure('UNAUTHORIZED', 401)
        if admitted >= config.concurrency:
            return failure('BUSY', 429)
        admitted += 1
        current = asyncio.current_task()
        requests.add(current)
        work = None
        disconnected = None
        released = False
        def release(_task=None):
            nonlocal admitted, released
            if not released:
                admitted -= 1
                released = True
            if _task is not None:
                active.discard(_task)
                consume(_task)
        end = asyncio.get_running_loop().time() + config.deadline_seconds
        try:
            if request.scope.get('query_string') or sum(len(k)+len(v) for k,v in headers) > 8192:
                raise Refusal('INVALID_REQUEST', 400)
            if any(k.lower().startswith(b'x-summary-') and k.decode().lower() not in CONTEXT_HEADERS.values() for k,v in headers):
                raise Refusal('INVALID_REQUEST', 400)
            context = {}
            for key, header in CONTEXT_HEADERS.items():
                v = values(header)
                if len(v) != 1:
                    raise Refusal('INVALID_REQUEST', 400)
                context[key] = v[0].decode('ascii')
            lengths = values('content-length')
            if len(lengths)>1 or (lengths and not re.fullmatch(rb'[0-9]{1,9}', lengths[0])):
                raise Refusal('INVALID_REQUEST', 400)
            declared = int(lengths[0]) if lengths else None
            if declared is not None and declared > LIMITS['inputBytes']:
                raise Refusal('SOURCE_TOO_LARGE', 413)
            if values('content-encoding') not in ([], [b'identity']):
                raise Refusal('INVALID_REQUEST', 400)
            if values('content-type') not in ([b'application/json'], [b'application/json; charset=utf-8']):
                raise Refusal('INVALID_REQUEST', 415)
            body = bytearray()
            chunks = 0
            async with asyncio.timeout_at(end):
                while True:
                    message = await request.receive()
                    if message['type'] == 'http.disconnect':
                        raise Refusal('CANCELLED', 499)
                    if message['type'] != 'http.request' or type(message.get('body', b'')) is not bytes:
                        raise Refusal('INVALID_REQUEST', 400)
                    chunk = message.get('body', b'')
                    chunks += 1
                    if chunks > 10000:
                        raise Refusal('INVALID_REQUEST', 400)
                    await asyncio.sleep(0)
                    if len(body)+len(chunk) > LIMITS['inputBytes']:
                        raise Refusal('SOURCE_TOO_LARGE', 413)
                    body.extend(chunk)
                    if not message.get('more_body', False):
                        break
            if declared is not None and declared != len(body):
                raise Refusal('INVALID_REQUEST', 400)
            raw = parse_summary_json(bytes(body), 'input')
            if closing:
                raise Refusal('SERVICE_DISABLED', 503)
            work = asyncio.create_task(generate_summary(raw, context, provider))
            active.add(work)
            async def watch_disconnect():
                while True:
                    message = await request.receive()
                    if message['type'] == 'http.disconnect':
                        return
                    await asyncio.sleep(0)
            disconnected = asyncio.create_task(watch_disconnect())
            done, _ = await asyncio.wait((work, disconnected), timeout=max(0,end-asyncio.get_running_loop().time()), return_when=asyncio.FIRST_COMPLETED)
            if disconnected in done:
                raise Refusal('CANCELLED', 499)
            if work not in done or asyncio.get_running_loop().time() >= end:
                raise Refusal('DEADLINE_EXCEEDED', 504)
            result = work.result()
            return Response(result, media_type='application/json', headers={'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'})
        except Refusal as exc:
            return failure(exc.code, exc.status)
        except SummaryValidationError as exc:
            return failure(exc.code, 413 if exc.code == 'SOURCE_TOO_LARGE' else 422)
        except TimeoutError:
            return failure('DEADLINE_EXCEEDED', 504)
        except asyncio.CancelledError:
            raise
        except Exception:
            return failure('SERVICE_FAILURE', 502)
        finally:
            requests.discard(current)
            if disconnected is not None:
                cancel_once(disconnected)
                disconnected.add_done_callback(consume)
            if work is not None and not work.done():
                cancel_once(work)
                work.add_done_callback(release)
            else:
                if work is not None:
                    active.discard(work)
                    consume(work)
                release()
    return app
