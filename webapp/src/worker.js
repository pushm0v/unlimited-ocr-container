import { claimNextFile, completeFile, failFile } from './db.js';
import { ocrFile } from './ocr.js';

const IDLE_MS = Number(process.env.WORKER_IDLE_MS ?? 2000);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);
// Two GPUs, so two files can be in flight at once. Raising this past the
// number of cards just queues requests inside nginx for no gain.
const WORKERS = Number(process.env.WORKER_CONCURRENCY ?? 2);

async function runOne(label) {
  const file = await claimNextFile();
  if (!file) return false;

  console.log(`[${label}] processing ${file.filename} (attempt ${file.attempts})`);
  try {
    const result = await ocrFile(file.filename, file.payload);
    await completeFile(file.id, {
      pages: result.pages,
      markdown: result.markdown,
    });
    console.log(`[${label}] done ${file.filename} (${result.pages} pages)`);
  } catch (e) {
    // Retry transient failures (backend restarting after OOM) until the
    // attempt budget runs out; give up immediately on deterministic ones such
    // as an unsupported file type, which would fail identically every time.
    const retry = e.retryable && file.attempts < MAX_ATTEMPTS;
    console.error(`[${label}] ${retry ? 'retrying' : 'failed'} ${file.filename}: ${e.message}`);
    await failFile(file.id, e.message, { retry });
  }
  return true;
}

async function loop(label) {
  for (;;) {
    let worked = false;
    try {
      worked = await runOne(label);
    } catch (e) {
      console.error(`[${label}] loop error: ${e.message}`);
    }
    if (!worked) await new Promise((r) => setTimeout(r, IDLE_MS));
  }
}

export function startWorkers() {
  for (let i = 0; i < WORKERS; i++) loop(`worker${i}`);
  console.log(`[worker] started ${WORKERS} loop(s)`);
}
