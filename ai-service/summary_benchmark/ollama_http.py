"""Explicit loopback-only async HTTP port. No proxy, credentials, redirects or SDK.

Construction/import has no network effects. Callers must independently authorize
execution; Stage 3A.5C tests inject streams and never connect to a real daemon.
"""
import asyncio
import json
from dataclasses import dataclass

ENDPOINT = 'http://127.0.0.1:11434'
MAX_WIRE_BYTES = 262144


class TransportRefused(Exception):
    def __init__(self):
        super().__init__('LOCAL_TRANSPORT_REFUSED')


@dataclass(frozen=True, repr=False)
class HttpReply:
    status: int
    body: bytes


class LoopbackHttpTransport:
    """No automatic use: explicit opt-in plus adapter/host admission is required.

    One connection per request, bounded reads and connection-close semantics.
    A closed connection is NOT proof that Ollama stopped inference.
    """
    def __init__(self, *, enabled=False, endpoint=ENDPOINT):
        if type(enabled) is not bool or endpoint != ENDPOINT:
            raise TransportRefused()
        self.enabled = enabled

    async def request(self, method, path, payload, *, timeout_s, max_bytes):
        writer = None
        cancelled = False
        failed = False
        try:
            if not self.enabled or (method, path) not in {
                ('GET', '/api/version'), ('GET', '/api/tags'),
                ('POST', '/api/show'), ('POST', '/api/chat')
            } or not 0 < max_bytes <= MAX_WIRE_BYTES or not 0 < timeout_s <= 180:
                raise TransportRefused()
            # Environment proxy support is deliberately absent, including NO_PROXY.
            from .ollama_local import refuse_proxies
            refuse_proxies()
            raw = b'' if payload is None else json.dumps(payload, ensure_ascii=False,
                    separators=(',', ':'), allow_nan=False).encode()
            if len(raw) > MAX_WIRE_BYTES:
                raise TransportRefused()
            async with asyncio.timeout(timeout_s):
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection('127.0.0.1', 11434, limit=16384), min(2, timeout_s))
                head = (f'{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:11434\r\n'
                        'Connection: close\r\nContent-Type: application/json\r\n'
                        f'Content-Length: {len(raw)}\r\n\r\n').encode('ascii')
                writer.write(head + raw)
                await writer.drain()
                headers = await reader.readuntil(b'\r\n\r\n')
                if len(headers) > 16384:
                    raise TransportRefused()
                lines = headers[:-4].split(b'\r\n')
                status = lines[0].split(b' ')
                if len(status) < 2 or status[0] != b'HTTP/1.1' or status[1] != b'200':
                    raise TransportRefused()  # Including every redirect; never follow.
                fields = {}
                for line in lines[1:]:
                    key, value = line.split(b':', 1)
                    key = key.strip().lower()
                    if key in fields:
                        raise TransportRefused()
                    fields[key] = value.strip().lower()
                if (fields.get(b'content-type', b'').split(b';')[0] != b'application/json'
                        or b'transfer-encoding' in fields or b'content-encoding' in fields):
                    raise TransportRefused()
                # stream=false Ollama responses must have bounded Content-Length.
                # Unsupported/chunked framing fails closed, rather than guessing.
                length = int(fields[b'content-length'])
                if not 0 < length <= max_bytes:
                    raise TransportRefused()
                body = await reader.readexactly(length)
                return HttpReply(200, body)
        except asyncio.CancelledError:
            cancelled = True
        except Exception:
            failed = True
        finally:
            if writer is not None:
                writer.close()
                try:
                    await asyncio.wait_for(writer.wait_closed(), .2)
                except (Exception, asyncio.CancelledError):
                    pass
        if cancelled:
            raise asyncio.CancelledError()
        if failed:
            raise TransportRefused()
