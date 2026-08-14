#!/usr/bin/env python
"""HTTP OCR service wrapping a persistent SGLang server.

Unlike infer.py, which starts SGLang, runs one batch and tears it down, this
keeps the server resident and exposes OCR over HTTP. Model weights load once at
startup instead of once per job.

Endpoints:
  GET  /health   200 once the SGLang backend is ready (Dokploy health check)
  POST /ocr      multipart file upload (pdf or image) -> markdown

The request payload mirrors infer.py exactly: same prompt, temperature,
skip_special_tokens and no-repeat-ngram custom logit processor. Divergence here
would silently change OCR quality relative to the batch path.
"""

import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

SERVED_MODEL_NAME = "Unlimited-OCR"
BACKEND_URL = "http://127.0.0.1:10000"
PROMPT = "document parsing."
TEMPERATURE = 0
NO_REPEAT_NGRAM_SIZE = 35
NGRAM_WINDOW = 128
REQUEST_TIMEOUT = 1200
PDF_DPI = int(os.environ.get("PDF_DPI", "300"))
SERVE_PORT = int(os.environ.get("SERVE_PORT", "8000"))
CONCURRENCY = int(os.environ.get("CONCURRENCY", "4"))
STARTUP_TIMEOUT = int(os.environ.get("STARTUP_TIMEOUT", "900"))

IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
_ngram_processor_str = None
_backend_ready = False


def ngram_processor_str():
    global _ngram_processor_str
    if _ngram_processor_str is None:
        from sglang.srt.sampling.custom_logit_processor import (
            DeepseekOCRNoRepeatNGramLogitProcessor,
        )
        _ngram_processor_str = DeepseekOCRNoRepeatNGramLogitProcessor.to_str()
    return _ngram_processor_str


def backend_ready() -> bool:
    try:
        return requests.get(f"{BACKEND_URL}/health", timeout=5).status_code == 200
    except requests.RequestException:
        return False


def start_backend():
    """Launch SGLang with flags tuned for a 12GB SM86 card.

    infer.py hardcodes mem-fraction 0.8 and the fa3 attention backend as module
    constants, so they are unreachable from the CLI. Passing them explicitly here
    is the whole reason this path exists.
    """
    cmd = [
        sys.executable, "-m", "sglang.launch_server",
        "--model", os.environ.get("MODEL_DIR", "baidu/Unlimited-OCR"),
        "--served-model-name", SERVED_MODEL_NAME,
        "--attention-backend", os.environ.get("ATTENTION_BACKEND", "flashinfer"),
        "--page-size", "1",
        "--mem-fraction-static", os.environ.get("MEM_FRACTION_STATIC", "0.75"),
        "--context-length", os.environ.get("CONTEXT_LENGTH", "16384"),
        "--enable-custom-logit-processor",
        "--disable-overlap-schedule",
        "--skip-server-warmup",
        "--host", "127.0.0.1",
        "--port", "10000",
    ]
    print(f"[serve] starting backend: {' '.join(cmd)}", flush=True)
    proc = subprocess.Popen(cmd, stdout=sys.stdout, stderr=subprocess.STDOUT)

    start = time.time()
    while time.time() - start < STARTUP_TIMEOUT:
        if proc.poll() is not None:
            raise RuntimeError(f"SGLang exited early with code {proc.returncode}")
        if backend_ready():
            print(f"[serve] backend ready in {time.time() - start:.0f}s", flush=True)
            return proc
        time.sleep(3)
    proc.kill()
    raise TimeoutError("timed out waiting for SGLang backend")


def encode_image_bytes(data: bytes, ext: str) -> dict:
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else f"image/{ext.lstrip('.')}"
    b64 = base64.b64encode(data).decode("utf-8")
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}


def infer_one(image_bytes: bytes, ext: str, image_mode: str) -> str:
    payload = {
        "model": SERVED_MODEL_NAME,
        "messages": [{
            "role": "user",
            "content": [{"type": "text", "text": PROMPT},
                        encode_image_bytes(image_bytes, ext)],
        }],
        "temperature": TEMPERATURE,
        "skip_special_tokens": False,
        "stream": False,
        "images_config": {"image_mode": image_mode},
    }
    if NO_REPEAT_NGRAM_SIZE > 0 and NGRAM_WINDOW > 0:
        payload["custom_logit_processor"] = ngram_processor_str()
        payload["custom_params"] = {
            "ngram_size": NO_REPEAT_NGRAM_SIZE,
            "window_size": NGRAM_WINDOW,
        }

    resp = requests.post(
        f"{BACKEND_URL}/v1/chat/completions",
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload),
        timeout=REQUEST_TIMEOUT,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def pdf_pages_to_pngs(pdf_bytes: bytes) -> list:
    import fitz

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    mat = fitz.Matrix(PDF_DPI / 72, PDF_DPI / 72)
    pages = [page.get_pixmap(matrix=mat).tobytes("png") for page in doc]
    doc.close()
    return pages


def ocr_payload(filename: str, blob: bytes, image_mode: str) -> dict:
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".pdf":
        pages = pdf_pages_to_pngs(blob)
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            texts = list(pool.map(lambda p: infer_one(p, ".png", image_mode), pages))
        return {"filename": filename, "pages": len(texts),
                "markdown": "\n\n".join(texts), "page_markdown": texts}
    if ext in IMAGE_EXTS:
        text = infer_one(blob, ext, image_mode)
        return {"filename": filename, "pages": 1, "markdown": text,
                "page_markdown": [text]}
    raise ValueError(f"unsupported file type: {ext or filename}")


def parse_multipart(body: bytes, content_type: str):
    """Minimal multipart parser - avoids pulling a web framework into the image."""
    marker = "boundary="
    if marker not in content_type:
        raise ValueError("missing multipart boundary")
    boundary = content_type.split(marker, 1)[1].strip().strip('"')
    sep = f"--{boundary}".encode()
    for part in body.split(sep):
        if b"\r\n\r\n" not in part:
            continue
        raw_headers, payload = part.split(b"\r\n\r\n", 1)
        headers = raw_headers.decode("utf-8", "replace")
        if "filename=" not in headers:
            continue
        filename = headers.split("filename=", 1)[1].split("\r\n", 1)[0].strip().strip('"')
        if not filename:
            continue
        # Strip exactly the one CRLF that precedes the next boundary - a blanket
        # rstrip would eat trailing bytes belonging to the file itself.
        if payload.endswith(b"\r\n"):
            payload = payload[:-2]
        return filename, payload
    raise ValueError("no file part in upload")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, obj: dict):
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.split("?")[0] != "/health":
            return self._send(404, {"error": "not found"})
        if _backend_ready and backend_ready():
            return self._send(200, {"status": "ok"})
        self._send(503, {"status": "loading"})

    def do_POST(self):
        if self.path.split("?")[0] != "/ocr":
            return self._send(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                return self._send(400, {"error": "empty body"})
            body = self.rfile.read(length)
            filename, blob = parse_multipart(body, self.headers.get("Content-Type", ""))
            mode = "gundam"
            if "image_mode=base" in (self.path.split("?", 1) + [""])[1]:
                mode = "base"
            self._send(200, ocr_payload(filename, blob, mode))
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - surface backend failures to caller
            self._send(500, {"error": f"{type(e).__name__}: {e}"})

    def log_message(self, fmt, *a):
        print(f"[http] {fmt % a}", flush=True)


def watch_backend(proc, server):
    """Exit the process if SGLang dies, so the container restart policy fires.

    Without this the HTTP server keeps serving after an OOM kill: the container
    stays "up", /health returns 503 forever, and nginx quietly reroutes every
    request onto the surviving GPU. Docker only restarts containers that exit,
    not ones merely marked unhealthy, so a dead backend must take the process
    down with it.
    """
    while True:
        time.sleep(10)
        code = proc.poll()
        if code is None:
            continue
        # poll() reports a signal death as a negative number: -9 is SIGKILL,
        # which is what the kernel OOM killer sends.
        reason = "OOM-killed" if code in (-9, 137) else f"exited with code {code}"
        print(f"[serve] SGLang {reason}; shutting down so the container "
              f"is restarted", flush=True)
        # Always exit non-zero, even if the backend exited 0 - a backend that
        # is gone makes this process useless, and restart:on-failure only
        # triggers on a non-zero status.
        os._exit(137 if code in (-9, 137) else 1)


def main():
    global _backend_ready
    proc = start_backend()
    _backend_ready = True
    server = ThreadingHTTPServer(("0.0.0.0", SERVE_PORT), Handler)
    threading.Thread(target=watch_backend, args=(proc, server), daemon=True).start()
    print(f"[serve] listening on :{SERVE_PORT}", flush=True)
    try:
        server.serve_forever()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
