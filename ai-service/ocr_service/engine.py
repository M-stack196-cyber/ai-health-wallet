"""Bounded local Poppler/Tesseract extraction. No shell, URL, model or network calls."""
import asyncio
import csv
import io
import os
import re
import signal
from pathlib import Path
from PIL import Image, ImageOps

class ProcessingFailure(Exception):
    def __init__(self, code="INVALID_INPUT", retryable=False):
        self.code, self.retryable = code, retryable
        super().__init__(code)

TOOLS = {"pdfinfo": "/usr/bin/pdfinfo", "pdftotext": "/usr/bin/pdftotext",
         "pdftoppm": "/usr/bin/pdftoppm", "tesseract": "/usr/bin/tesseract"}

def clean(text):
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text).strip()

async def command(tool, args, directory, timeout=15):
    output = directory / "command.out"
    with output.open("wb") as sink:
        output.chmod(0o600)
        process = await asyncio.create_subprocess_exec(
            "/usr/bin/prlimit", "--as=1073741824", "--cpu=20", "--fsize=16777216", "--nofile=64", "--core=0", "--",
            TOOLS[tool], *map(str, args), cwd=directory,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "OMP_THREAD_LIMIT": "1", "OMP_NUM_THREADS": "1", "TMPDIR": str(directory)},
            stdin=asyncio.subprocess.DEVNULL, stdout=sink, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
        try:
            await asyncio.wait_for(process.wait(), timeout)
            if process.returncode != 0:
                raise ProcessingFailure()
        except (asyncio.CancelledError, TimeoutError):
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await process.wait()
            raise
        finally:
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()
    if output.stat().st_size > 4194304:
        raise ProcessingFailure("RESOURCE_LIMIT")
    return output.read_text("utf-8", errors="replace")

async def ocr_page(path, page, directory):
    normalized = directory / "normalized.png"
    try:
        with Image.open(path) as image:
            if image.width * image.height > 20000000 or image.width < 1 or image.height < 1:
                raise ProcessingFailure("RESOURCE_LIMIT")
            image = ImageOps.exif_transpose(image).convert("RGB")
            width, height = image.size
            image.save(normalized, "PNG")
    except (OSError, ValueError, Image.DecompressionBombError):
        raise ProcessingFailure() from None
    raw = await command("tesseract", [normalized, "stdout", "-l", "eng", "--psm", "6", "tsv"], directory)
    lines, confidence, fragments = {}, [], []
    for row in csv.DictReader(io.StringIO(raw), delimiter="\t", quoting=csv.QUOTE_NONE):
        word = clean(row.get("text", ""))
        if not word:
            continue
        try:
            score = float(row["conf"])
            if not 0 <= score <= 100:
                continue
            key = (row["block_num"], row["par_num"], row["line_num"])
            lines.setdefault(key, []).append(word)
            confidence.append(score)
            x, y, w, h = [int(row[k]) for k in ("left", "top", "width", "height")]
            fragments.append({"text": word, "region": [max(0, min(1, x / width)), max(0, min(1, y / height)),
                                max(0, min(1, w / width)), max(0, min(1, h / height))]})
        except (ValueError, KeyError, ZeroDivisionError):
            raise ProcessingFailure() from None
    text = clean("\n".join(" ".join(words) for words in lines.values()))
    return {"page": page, "method": "ocr", "text": text,
            "confidence": round(sum(confidence) / len(confidence), 2) if confidence else 0,
            "fragments": fragments}

async def extract(path, media_type, directory, max_pages):
    pages = []
    if media_type == "application/pdf":
        if path.read_bytes()[:5] != b"%PDF-":
            raise ProcessingFailure()
        info = await command("pdfinfo", [path], directory)
        match = re.search(r"^Pages:\s+(\d+)$", info, re.M)
        if not match or re.search(r"^Encrypted:\s+yes", info, re.M):
            raise ProcessingFailure()
        count = int(match[1])
        if not 1 <= count <= max_pages:
            raise ProcessingFailure("RESOURCE_LIMIT")
        for page in range(1, count + 1):
            text = clean(await command("pdftotext", ["-f", page, "-l", page, "-layout", "-enc", "UTF-8", path, "-"], directory))
            if len(re.findall(r"[A-Za-z0-9]", text)) >= 8:
                pages.append({"page": page, "method": "pdf_text", "text": text,
                              "fragments": [{"text": line} for line in text.splitlines() if line.strip()]})
            else:
                prefix = directory / "rendered"
                await command("pdftoppm", ["-f", page, "-l", page, "-singlefile", "-scale-to", "2400", "-png", path, prefix], directory)
                pages.append(await ocr_page(directory / "rendered.png", page, directory))
    else:
        magic = path.read_bytes()[:8]
        if (media_type == "image/png" and magic != b"\x89PNG\r\n\x1a\n") or (media_type == "image/jpeg" and magic[:3] != b"\xff\xd8\xff"):
            raise ProcessingFailure()
        pages.append(await ocr_page(path, 1, directory))
    if not any(p["text"].strip() for p in pages):
        raise ProcessingFailure("EMPTY_TEXT")
    if sum(len(p["text"]) for p in pages) > 1000000 or sum(len(p["fragments"]) for p in pages) > 30000:
        raise ProcessingFailure("RESOURCE_LIMIT")
    return pages
