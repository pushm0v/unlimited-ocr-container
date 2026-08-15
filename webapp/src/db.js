import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
});

// Jobs are claimed by a worker loop that may run in more than one replica, so
// state transitions have to be safe under concurrency. See claimNextFile().
const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id          TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS files (
  id           BIGSERIAL PRIMARY KEY,
  batch_id     TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  pages        INTEGER,
  markdown     TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  payload      BYTEA,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS files_batch_idx  ON files (batch_id);
CREATE INDEX IF NOT EXISTS files_status_idx ON files (status, id);
`;

export async function migrate() {
  await pool.query(SCHEMA);
  // Recover files that were mid-flight when the process died. Without this a
  // crash during OCR leaves rows stuck in 'processing' forever.
  const { rowCount } = await pool.query(
    `UPDATE files SET status = 'queued', started_at = NULL
      WHERE status = 'processing'`
  );
  if (rowCount > 0) console.log(`[db] requeued ${rowCount} interrupted file(s)`);
}

export async function createBatch(id, files) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO batches (id) VALUES ($1)', [id]);
    for (const f of files) {
      await client.query(
        'INSERT INTO files (batch_id, filename, payload) VALUES ($1, $2, $3)',
        [id, f.filename, f.blob]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Atomically take the oldest queued file.
 *
 * FOR UPDATE SKIP LOCKED lets several workers poll the same table without
 * handing the same file to two GPUs: a row locked by one worker is skipped
 * rather than waited on.
 */
export async function claimNextFile() {
  const { rows } = await pool.query(
    `UPDATE files SET status = 'processing',
                      started_at = now(),
                      attempts = attempts + 1
      WHERE id = (
        SELECT id FROM files
         WHERE status = 'queued'
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, filename, payload, attempts`
  );
  return rows[0] ?? null;
}

export async function completeFile(id, { pages, markdown }) {
  // payload is cleared on success so the DB does not grow without bound.
  await pool.query(
    `UPDATE files SET status = 'done', pages = $2, markdown = $3,
                      payload = NULL, finished_at = now(), error = NULL
      WHERE id = $1`,
    [id, pages, markdown]
  );
}

export async function failFile(id, message, { retry }) {
  await pool.query(
    `UPDATE files
        SET status = $3,
            error = $2,
            payload = CASE WHEN $3 = 'failed' THEN NULL ELSE payload END,
            finished_at = CASE WHEN $3 = 'failed' THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, message, retry ? 'queued' : 'failed']
  );
}

export async function getBatch(id) {
  const { rows } = await pool.query(
    `SELECT id, filename, status, pages, error, markdown
       FROM files WHERE batch_id = $1 ORDER BY id`,
    [id]
  );
  return rows;
}
