/**
 * Client for the OCR balancer.
 *
 * The backend blocks for the whole document with no progress output, so the
 * timeout here has to cover a worst-case PDF. It is deliberately aligned with
 * nginx proxy_read_timeout and REQUEST_TIMEOUT in scripts/serve.py; making it
 * shorter would abandon work the GPU is still doing.
 */

const OCR_URL = process.env.OCR_URL ?? 'http://balancer:8080';
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS ?? 1_200_000);
// Shared secret for the cross-box hop. Empty = disabled (single-box / trusted
// network); when set it must match OCR_SHARED_TOKEN on the GPU box.
const OCR_TOKEN = process.env.OCR_SHARED_TOKEN ?? '';

function authHeaders() {
  return OCR_TOKEN ? { 'X-OCR-Token': OCR_TOKEN } : {};
}

export async function ocrFile(filename, blob, imageMode = 'gundam') {
  const form = new FormData();
  form.append('file', new Blob([blob]), filename);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS);
  try {
    const res = await fetch(`${OCR_URL}/ocr?image_mode=${imageMode}`, {
      method: 'POST',
      body: form,
      headers: authHeaders(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try { detail = JSON.parse(text).error ?? detail; } catch { /* keep raw */ }
      const err = new Error(`OCR ${res.status}: ${detail}`);
      // 503 means a backend is still loading weights (or restarting after an
      // OOM). That is transient, so the caller should requeue rather than
      // marking the file permanently failed.
      err.retryable = res.status === 503 || res.status === 502;
      throw err;
    }
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`OCR timed out after ${OCR_TIMEOUT_MS}ms`);
      err.retryable = false;
      throw err;
    }
    if (e.retryable === undefined) e.retryable = true; // network blip
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function ocrHealthy() {
  try {
    const res = await fetch(`${OCR_URL}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
