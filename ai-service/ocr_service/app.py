"""Authenticated loopback-only factory; request content and errors are never logged."""
import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from uuid import UUID
from fastapi import FastAPI, Request
from starlette.responses import JSONResponse
from .engine import extract, ProcessingFailure, TOOLS
import subprocess
import PIL

@dataclass(frozen=True, repr=False)
class Config:
    token: str = field(repr=False)
    max_bytes: int = 20971520
    max_pages: int = 100
    concurrency: int = 1
    deadline_seconds: float = 120

    def __post_init__(self):
        if not (isinstance(self.token, str) and re.fullmatch(r"[a-f0-9]{64}", self.token)
                and type(self.max_bytes) is int and 1024 <= self.max_bytes <= 20971520
                and type(self.max_pages) is int and 1 <= self.max_pages <= 200
                and type(self.concurrency) is int and 1 <= self.concurrency <= 2
                and 0.1 <= self.deadline_seconds <= 300):
            raise ValueError("INVALID_OCR_CONFIGURATION")

def reply(value, status=200):
    return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})

def failure(code, retryable=False, status=422):
    return reply({"schema_version": 1, "ok": False, "error": {"code": code, "retryable": retryable}}, status)

def uuid(value):
    return isinstance(value, str) and str(UUID(value)) == value

def create_app(config):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    active = 0
    versions = {"pillow": PIL.__version__}
    for name in ("pdfinfo", "tesseract"):
        try:
            result = subprocess.run([TOOLS[name], "--version" if name == "tesseract" else "-v"],
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=3,
                                    env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, check=True)
            versions[name] = result.stdout.decode("utf-8", errors="replace").splitlines()[0][:120]
        except (OSError, subprocess.SubprocessError, IndexError):
            versions[name] = "unavailable"
    @app.middleware("http")
    async def authorize(request, call_next):
        auth = request.headers.get("authorization", "")
        if len(auth) > 256 or not hmac.compare_digest(hashlib.sha256(auth.encode()).digest(), hashlib.sha256(("Bearer " + config.token).encode()).digest()):
            return failure("UNAUTHORIZED_SERVICE", status=401)
        if request.url.query:
            return failure("INVALID_REQUEST", status=400)
        return await call_next(request)

    @app.get("/health")
    async def health():
        return reply({"schema_version": 1, "live": True})

    @app.get("/ready")
    async def ready():
        available = all(shutil.which(tool) for tool in TOOLS.values())
        return reply({"schema_version": 1, "ready": available}, 200 if available else 503)

    @app.post("/v1/extractions")
    async def process(request: Request):
        nonlocal active
        if active >= config.concurrency:
            return failure("BUSY", True, 503)
        active += 1
        monitor = None
        async def work():
            nonlocal monitor
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > config.max_bytes * 4 // 3 + 4096:
                    raise ProcessingFailure("RESOURCE_LIMIT")
            try:
                value = json.loads(body)
                keys = {"schema_version", "request_id", "document_id", "job_id", "attempt", "fence_token", "media_type", "source_sha256", "content_base64", "mode"}
                if (not isinstance(value, dict) or set(value) != keys or type(value["schema_version"]) is not int or value["schema_version"] != 1
                    or any(not uuid(value[k]) for k in ("request_id", "document_id", "job_id", "fence_token"))
                    or value["job_id"] != value["document_id"] or type(value["attempt"]) is not int or not 1 <= value["attempt"] <= 5
                    or value["mode"] != "native_or_ocr" or value["media_type"] not in ("application/pdf", "image/jpeg", "image/png")
                    or not isinstance(value["source_sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["source_sha256"])):
                    raise ValueError()
                content = base64.b64decode(value["content_base64"], validate=True)
                if not 0 < len(content) <= config.max_bytes or hashlib.sha256(content).hexdigest() != value["source_sha256"]:
                    raise ValueError()
            except (ValueError, TypeError, KeyError, binascii.Error):
                raise ProcessingFailure("INVALID_REQUEST") from None
            monitor = asyncio.create_task(disconnect())
            with tempfile.TemporaryDirectory(prefix="hw-python-ocr-") as temporary:
                directory = Path(temporary)
                directory.chmod(0o700)
                path = directory / "source.bin"
                path.write_bytes(content)
                path.chmod(0o600)
                pages = await extract(path, value["media_type"], directory, config.max_pages)
                text = "\n\n".join(p["text"] for p in pages)
                methods = {p["method"] for p in pages}
                method = "mixed" if len(methods) > 1 else next(iter(methods))
                suggestion = None
                for candidate in re.findall(r"\b\d{4}-\d{2}-\d{2}\b", text):
                    try:
                        if date.fromisoformat(candidate) <= date.today():
                            suggestion = {"value": candidate, "confidence": 50}
                            break
                    except ValueError:
                        pass
                category = "prescription" if re.search(r"\bprescription\b", text, re.I) else "lab_report" if re.search(r"\b(lab report|laboratory|glucose)\b", text, re.I) else None
                return {"schema_version": 1, "ok": True,
                        **{k: value[k] for k in ("request_id", "document_id", "job_id", "attempt", "fence_token")},
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "extraction": {"text": text, "method": method, "extractor": {"name": "python-poppler-tesseract", "version": "ocr-contract-v1"},
                                       "source": {"sha256": value["source_sha256"], "pageCount": len(pages), "pages": [
                                           {k: p[k] for k in ("page", "method", "confidence") if k in p} for p in pages]}},
                        "structured": {"content_trust": "untrusted_document_data", "tools": versions, "pages": pages, "date_suggestion": suggestion,
                                       "category_suggestion": {"value": category, "confidence": 50} if category else None}}
        task = asyncio.create_task(work())
        def release(_finished):
            # Free the admission slot when the work has really ended (temporary files and subprocesses cleaned up).
            # Doing this in the request's finally block leaked the slot: after a client cancel the awaits there are
            # cancelled again and the decrement was skipped.
            nonlocal active
            active -= 1
        task.add_done_callback(release)
        async def disconnect():
            while not task.done():
                await asyncio.sleep(0.1)
                if await request.is_disconnected():
                    task.cancel()
                    return
        try:
            result = await asyncio.wait_for(task, config.deadline_seconds)
            return reply(result)
        except TimeoutError:
            return failure("TIMEOUT", True, 504)
        except ProcessingFailure as error:
            return failure(error.code, error.retryable)
        except asyncio.CancelledError:
            task.cancel()
            raise
        except Exception:
            return failure("PROCESSOR_FAILED", True, 503)
        finally:
            if monitor:
                monitor.cancel()
            if not task.done():
                task.cancel()
            # Shielded so a repeated cancel cannot abandon the wait; the slot is released by the done callback above.
            await asyncio.shield(asyncio.gather(*([monitor] if monitor else []), task, return_exceptions=True))
    return app
