import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { migrate, createBatch, getBatch, pool } from './db.js';
import { startWorkers } from './worker.js';
import { ocrHealthy } from './ocr.js';
import { parseMultipart } from './multipart.js';

const PORT = Number(process.env.PORT ?? 3000);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES ?? 512 * 1024 * 1024);
const ALLOWED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

function json(res, code, obj) {
  const raw = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': raw.length,
  });
  res.end(raw);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // Abort early instead of buffering a payload we will reject anyway.
      if (size > limit) {
        reject(Object.assign(new Error('upload too large'), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const ext = (name) => {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
};

async function handleUpload(req, res) {
  let body;
  try {
    body = await readBody(req, MAX_UPLOAD);
  } catch (e) {
    return json(res, e.code === 413 ? 413 : 400, { error: e.message });
  }

  let files;
  try {
    files = parseMultipart(body, req.headers['content-type']);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  if (files.length === 0) return json(res, 400, { error: 'no files uploaded' });

  const bad = files.filter((f) => !ALLOWED.has(ext(f.filename)));
  if (bad.length) {
    return json(res, 400, {
      error: `unsupported file type: ${bad.map((f) => f.filename).join(', ')}`,
    });
  }

  const batchId = randomUUID();
  await createBatch(batchId, files);
  console.log(`[api] batch ${batchId}: queued ${files.length} file(s)`);
  json(res, 202, { batch_id: batchId, files: files.length });
}

async function handleStatus(res, batchId) {
  const rows = await getBatch(batchId);
  if (rows.length === 0) return json(res, 404, { error: 'batch not found' });
  json(res, 200, {
    batch_id: batchId,
    done: rows.every((r) => r.status === 'done' || r.status === 'failed'),
    files: rows.map((r) => ({
      filename: r.filename,
      status: r.status,
      pages: r.pages,
      error: r.error,
      // Result bodies are fetched per-file so polling stays cheap.
      has_result: r.markdown != null,
    })),
  });
}

async function handleResult(res, batchId, filename) {
  const rows = await getBatch(batchId);
  const row = rows.find((r) => r.filename === filename);
  if (!row || row.markdown == null) return json(res, 404, { error: 'result not found' });
  const raw = Buffer.from(row.markdown, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Content-Length': raw.length,
    'Content-Disposition': `attachment; filename="${filename.replace(/\.[^.]+$/, '')}.md"`,
  });
  res.end(raw);
}

async function serveStatic(res) {
  try {
    const html = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      return await serveStatic(res);
    }
    if (req.method === 'GET' && path === '/health') {
      const ok = await ocrHealthy();
      // Report DB and OCR separately so a failing dependency is obvious.
      let db = true;
      try { await pool.query('SELECT 1'); } catch { db = false; }
      return json(res, db ? 200 : 503, { db, ocr: ok });
    }
    if (req.method === 'POST' && path === '/api/upload') {
      return await handleUpload(req, res);
    }
    const status = /^\/api\/batches\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && status) {
      return await handleStatus(res, status[1]);
    }
    const result = /^\/api\/batches\/([^/]+)\/files\/(.+)$/.exec(path);
    if (req.method === 'GET' && result) {
      return await handleResult(res, result[1], decodeURIComponent(result[2]));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`[api] ${req.method} ${path} failed: ${e.stack}`);
    json(res, 500, { error: e.message });
  }
});

await migrate();
startWorkers();
server.listen(PORT, '0.0.0.0', () => console.log(`[api] listening on :${PORT}`));
