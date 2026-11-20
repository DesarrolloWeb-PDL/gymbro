// The Postgres driver behind the storage seam (gymbro vercel port, T4c): what
// STORAGE_DRIVER=postgres selects, with DATABASE_URL as the connection string. Every logical
// key the API writes (`db.json`, `state-<uid>.json`, `audit.log`, `secret`, …) becomes rows —
// see classifyKey for the full mapping and api/migrations/0001_init.sql for the schema.
//
// WHY THIS DRIVER IS SYNCHRONOUS. The seam and every call site in server.js are synchronous
// (readState returns a document, saveDb returns nothing), and T4c may not change a single call
// site — moving to a Promise-shaped driver would turn loadDb's `db` into a Promise and corrupt
// an instance in ways no test here could catch. node-postgres is asynchronous, so the bridge
// below runs the client ONCE on a worker thread and blocks the calling thread on Atomics.wait
// until the reply file lands — the same "block the event loop for a few milliseconds" the fs
// driver already does with fsync on every write. One round trip on a warm connection, no
// change at any call site. A query that never comes back fails after a timeout instead of
// freezing the server forever, and a dead worker is replaced on the next query.
//
// WHAT `rev` IS. `docs.rev` MIRRORS the `_rev` inside the jsonb (0 when the document carries
// none): server.js compares the client's `baseRev` against that field, so the column must hold
// the same number or the compare-and-swap would refuse a write the read would accept. Both are
// always written in one statement, so they cannot drift. swapJSON's UPDATE ... WHERE rev = $n
// returns 0 rows on a stale base — the conflict the caller turns into the existing
// 409-with-the-current-document path.
//
// `audit.log` is append-only rows (appendLine inserts one), and the retention rewrite of
// compactAudit is one statement, one implicit transaction: delete plus the kept rows, never a
// whole-file rewrite. `secret` is INSERT ... ON CONFLICT DO NOTHING: of two instances racing to
// create it at boot, the first wins and the loser's random bytes are discarded — both instances
// must sign their cookies with the SAME key or every session the other one issues is invalid.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** The document's `_rev` as the column holds it: a finite number, else 0. */
const revOf = doc => (doc && typeof doc === 'object' && Number.isFinite(doc._rev) ? doc._rev : 0);

const ENOENT = key => Object.assign(new Error(`ENOENT: no such document, stat '${key}'`), { code: 'ENOENT' });

/* ---------- keys: one row per logical key ---------- */

const UID = '([A-Za-z0-9_-]+)';

/** Instance-wide documents first: `integrations/outbox.json` would otherwise read as a uid. */
const DOCS = [
  [/^db\.json$/, () => ['', 'db']],
  [/^db\.json\.bak$/, () => ['', 'db-bak']],
  [/^org\.json$/, () => ['', 'org']],
  [/^org\.json\.bak$/, () => ['', 'org-bak']],
  [/^coach\.json$/, () => ['', 'coach-config']],
  [/^vapid\.json$/, () => ['', 'vapid']],
  [/^integrations\/outbox\.json$/, () => ['', 'integration-outbox']],
  [/^shared\/items\.json$/, () => ['', 'shared-items']],
  [/^shared\/items\.json\.bak$/, () => ['', 'shared-items-bak']],
  [/^shared\/blocklist\.json$/, () => ['', 'shared-blocklist']],
  [/^library\/shared\/items\.json$/, () => ['', 'shared-items']],
  [/^library\/shared\/items\.json\.bak$/, () => ['', 'shared-items-bak']],
  [/^library\/shared\/blocklist\.json$/, () => ['', 'shared-blocklist']],
  [new RegExp(`^state-${UID}\\.json$`), m => [m[1], 'state']],
  [new RegExp(`^watch-${UID}\\.json$`), m => [m[1], 'watch']],
  [new RegExp(`^share/${UID}\\.json$`), m => [m[1], 'share']],
  [new RegExp(`^coach/${UID}\\.json$`), m => [m[1], 'coach']],
  [new RegExp(`^integrations\\/(?:u-)?${UID}\\.json$`), m => [m[1], 'integration']],
];

/**
 * Where a logical key lives: `{ table: 'docs', uid, kind }`, `{ table: 'audit' }` or
 * `{ table: 'secrets', name }`. A key with no mapping THROWS — a write that vanished would come
 * back later as data that was "saved" and never was. An absolute path (one outside DATA_DIR,
 * which normalisation deliberately passes through) cannot name a row and says so.
 */
export function classifyKey(key) {
  if (typeof key !== 'string' || path.isAbsolute(key)) {
    throw new Error(`STORAGE_DRIVER=postgres: ${JSON.stringify(key)} is not a logical key (a full path cannot name a row)`);
  }
  if (key === 'audit.log') return { table: 'audit' };
  if (key === 'secret') return { table: 'secrets', name: 'secret' };
  for (const [re, to] of DOCS) {
    const m = re.exec(key);
    if (m) { const [uid, kind] = to(m); return { table: 'docs', uid, kind }; }
  }
  throw new Error(`STORAGE_DRIVER=postgres: key ${JSON.stringify(key)} has no row mapping; add it to classifyKey() in api/storage-postgres.js rather than letting the write disappear`);
}

/* ---------- the synchronous bridge ---------- */

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Runs `pg` on a worker thread and answers IN THE CALLING THREAD: the request goes over
 * postMessage (queued until the worker listens), the reply is written to a file, and the flag
 * in shared memory is raised only after the bytes are there — Atomics.wait in between. The
 * caller therefore gets plain rows, not a Promise, and the seam stays synchronous.
 *
 * The worker source is a string (eval: true) so the driver stays ONE file: the api/Dockerfile
 * COPY line is a per-module obligation, and one module is one line to add.
 */
const PG_WORKER_SOURCE = `
(async () => {
  const { parentPort, workerData } = await import('node:worker_threads');
  const fs = await import('node:fs');
  const flags = new Int32Array(workerData.sab);
  const answer = (msg, payload) => {
    try { fs.writeFileSync(msg.replyTo, JSON.stringify(payload)); }
    catch (e) { try { fs.writeFileSync(msg.replyTo, JSON.stringify({ ok: false, message: 'reply lost: ' + e.message })); } catch { /* the caller times out */ } }
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0);
  };
  let pgPromise = null;
  let pool = null;
  parentPort.on('message', msg => { run(msg).catch(e => answer(msg, { ok: false, message: e && e.message ? e.message : String(e), code: e && e.code })); });
  async function run(msg) {
    if (!pgPromise) pgPromise = import(workerData.pgUrl);
    const pg = await pgPromise;
    pg.types.setTypeParser(20, v => Number(v));   // bigint revisions and counts come back as numbers
    if (!pool) {
      pool = new pg.Pool({ connectionString: workerData.url, max: 1 });
      pool.on('error', () => { pool = null; });   // a broken pooled connection is rebuilt on the next query
    }
    const res = (msg.params && msg.params.length) ? await pool.query(msg.sql, msg.params) : await pool.query(msg.sql);
    answer(msg, { ok: true, rows: res.rows });
  }
})();
`;

export function createSyncBridge({ source = PG_WORKER_SOURCE, workerData = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const sab = new SharedArrayBuffer(4);
  const flags = new Int32Array(sab);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-pg-'));
  let worker = null;
  let seq = 0;
  let closed = false;

  const start = () => {
    worker = new Worker(source, {
      eval: true,
      workerData: { ...workerData, sab, dir },
      execArgv: [],        // `node --test`'s flags must not reach the worker
      stdout: true,        // the worker's own output stays its own
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    worker.on('error', () => { /* reported by the exit handler below */ });
    worker.on('exit', () => { worker = null; });
  };

  const query = (sql, params = []) => {
    if (closed) throw new Error('postgres bridge: query after close');
    if (!worker) start();
    const id = ++seq;
    const replyTo = path.join(dir, `${id}.json`);
    Atomics.store(flags, 0, 0);
    worker.postMessage({ id, sql, params, replyTo });
    Atomics.wait(flags, 0, 0, timeoutMs);
    if (Atomics.load(flags, 0) === 0) {
      // A silent worker (or one that died waiting on the network) is killed, not waited on
      // again: the next query starts a fresh one instead of inheriting a wedged thread.
      const w = worker;
      worker = null;
      if (w) w.terminate().catch(() => { /* already gone */ });
      throw new Error(`postgres bridge: no reply after ${timeoutMs} ms (sql: ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 120)}…)`);
    }
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(replyTo, 'utf8'));
    } catch (e) {
      throw new Error(`postgres bridge: reply ${id} was lost (${e.message})`);
    } finally {
      try { fs.rmSync(replyTo, { force: true }); } catch { /* best effort */ }
      Atomics.store(flags, 0, 0);
    }
    if (!payload.ok) {
      const err = new Error(payload.message);
      if (payload.code) err.code = payload.code;
      throw err;
    }
    return payload.rows;
  };

  const close = () => {
    closed = true;
    const w = worker;
    worker = null;
    const stopped = w ? w.terminate() : Promise.resolve();
    return Promise.resolve(stopped).then(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });
  };

  return { query, close };
}

/* ---------- the driver ---------- */

/**
 * Build the driver. It validates DATABASE_URL and resolves `pg` immediately — both are boot
 * errors an operator must see at start — but opens NO connection: the worker (and the pool)
 * starts on the first query, so importing server.js with STORAGE_DRIVER=postgres cannot dial
 * anything mid-boot.
 */
export function createPostgresDriver({ url } = {}) {
  if (!url) throw new Error('STORAGE_DRIVER=postgres needs DATABASE_URL as the connection string (see .env.example)');
  let pgUrl;
  try { pgUrl = import.meta.resolve('pg'); }
  catch { throw new Error('STORAGE_DRIVER=postgres: the "pg" package is not installed — run `npm install` in api/'); }

  const bridge = createSyncBridge({ workerData: { url, pgUrl } });
  const q = (sql, params) => bridge.query(sql, params);

  const upsertDoc = (t, doc) => q(
    'INSERT INTO docs (uid, kind, doc, rev) VALUES ($1, $2, $3, $4) ' +
    'ON CONFLICT (uid, kind) DO UPDATE SET doc = EXCLUDED.doc, rev = EXCLUDED.rev, updated_at = now()',
    [t.uid, t.kind, doc, revOf(doc)]);

  // appendLine's row: uid and timestamp come off the entry, as the audit table's columns say.
  const auditParts = line => {
    let entry;
    try { entry = JSON.parse(line); } catch { entry = { raw: String(line) }; }
    const uid = entry && typeof entry === 'object' && typeof entry.uid === 'string' ? entry.uid : null;
    const at = entry && typeof entry === 'object' && Number.isFinite(entry.ts) ? new Date(entry.ts) : new Date();
    return [at, uid, entry];
  };

  const appendAudit = line => {
    const [at, uid, entry] = auditParts(line);
    q('INSERT INTO audit (at, uid, entry) VALUES ($1, $2, $3)', [at, uid, entry]);
  };

  // compactAudit's retention rewrite: the kept lines replace every row, in ONE statement and
  // one implicit transaction — atomic the way a rename over the old file was.
  const replaceAudit = content => {
    const lines = String(content).split('\n').filter(Boolean);
    if (!lines.length) { q('DELETE FROM audit'); return; }
    const params = [];
    const values = lines.map(line => {
      params.push(...auditParts(line));
      const i = params.length;
      return `($${i - 2}, $${i - 1}, $${i})`;
    });
    q(`WITH del AS (DELETE FROM audit RETURNING id) INSERT INTO audit (at, uid, entry) VALUES ${values.join(', ')}`, params);
  };

  const driver = {
    atomicWrite(key, content, mode) {   // `mode` (0600) is fs's; rows have their own access control
      const t = classifyKey(key);
      if (t.table === 'audit') { replaceAudit(content); return; }
      if (t.table === 'secrets') {
        // The race to create `secret`: first writer wins, the loser changes nothing.
        q('INSERT INTO secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING', [t.name, String(content)]);
        return;
      }
      // A document that is not JSON is refused HERE, not stored as a blob that would read
      // back differently than fs stores it.
      upsertDoc(t, JSON.parse(content));
    },

    readJSON(key, fallback = null) {
      const t = classifyKey(key);
      if (t.table === 'audit') throw new Error('audit.log is stored as rows (table audit), not as one JSON document');
      if (t.table === 'secrets') {
        const r = q('SELECT value FROM secrets WHERE name = $1', [t.name]);
        return r.length ? JSON.parse(r[0].value) : fallback;   // fs parity: a hex secret throws SyntaxError
      }
      const r = q('SELECT doc FROM docs WHERE uid = $1 AND kind = $2', [t.uid, t.kind]);
      return r.length ? r[0].doc : fallback;
    },

    writeJSON(key, value, mode, space) {   // `space` (indent 2) is fs's: jsonb keeps no layout
      const t = classifyKey(key);
      if (t.table === 'audit') throw new Error('audit.log is rows: use appendLine');
      if (t.table === 'secrets') {
        q('INSERT INTO secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
          [t.name, JSON.stringify(value)]);
        return;
      }
      upsertDoc(t, value);
    },

    appendLine(key, line) {
      const t = classifyKey(key);
      if (t.table !== 'audit') throw new Error(`appendLine is for audit.log; ${JSON.stringify(key)} has no rows to append to`);
      appendAudit(line);
    },

    exists(key) {
      const t = classifyKey(key);
      if (t.table === 'audit') return q('SELECT 1 FROM audit LIMIT 1').length > 0;
      if (t.table === 'secrets') return q('SELECT 1 FROM secrets WHERE name = $1', [t.name]).length > 0;
      return q('SELECT 1 FROM docs WHERE uid = $1 AND kind = $2', [t.uid, t.kind]).length > 0;
    },

    /** Size and mtime of the row, with the ENOENT shape the seam's contract had on fs. */
    stat(key) {
      const t = classifyKey(key);
      if (t.table === 'audit') {
        const r = q('SELECT count(*) AS n, coalesce(sum(octet_length(entry::text) + 1), 0) AS size, max(at) AS latest FROM audit')[0];
        if (Number(r.n) === 0) throw ENOENT(key);
        return { size: Number(r.size), mtimeMs: Date.parse(r.latest) };
      }
      if (t.table === 'secrets') {
        const r = q('SELECT octet_length(value) AS size, updated_at FROM secrets WHERE name = $1', [t.name])[0];
        if (!r) throw ENOENT(key);
        return { size: Number(r.size), mtimeMs: Date.parse(r.updated_at) };
      }
      const r = q('SELECT octet_length(doc::text) AS size, updated_at FROM docs WHERE uid = $1 AND kind = $2', [t.uid, t.kind])[0];
      if (!r) throw ENOENT(key);
      return { size: Number(r.size), mtimeMs: Date.parse(r.updated_at) };
    },

    /**
     * Compare-and-swap: write `value` only if the stored revision is still `baseRev`.
     * 0 rows back = conflict (stale base, or no row while the caller thinks there is one) and
     * the caller answers the existing 409 with the current document; `{ rev }` = written.
     *
     *   WITH upd AS (UPDATE docs … WHERE uid=$1 AND kind=$2 AND rev=$5 RETURNING rev),
     *        ins AS (INSERT … WHERE $5 = 0 AND NOT EXISTS (SELECT 1 FROM upd)
     *                ON CONFLICT DO NOTHING RETURNING rev)
     *   SELECT rev FROM upd UNION ALL SELECT rev FROM ins
     *
     * The INSERT half exists because a bare UPDATE returns 0 rows for a row that does not exist
     * YET — which would answer the very first write with a false conflict. It is gated on
     * baseRev 0 (nobody ever read a document), and two instances racing to create the same row
     * resolve to exactly one winner through ON CONFLICT.
     */
    swapJSON(key, value, baseRev) {
      const t = classifyKey(key);
      if (t.table !== 'docs') throw new Error(`swapJSON: ${JSON.stringify(key)} has no revision to compare against`);
      const rows = q(
        'WITH upd AS (' +
        ' UPDATE docs SET doc = $3, rev = $4, updated_at = now() WHERE uid = $1 AND kind = $2 AND rev = $5 RETURNING rev' +
        '), ins AS (' +
        ' INSERT INTO docs (uid, kind, doc, rev) SELECT $1, $2, $3, $4 WHERE $5 = 0 AND NOT EXISTS (SELECT 1 FROM upd)' +
        ' ON CONFLICT (uid, kind) DO NOTHING RETURNING rev' +
        ') SELECT rev FROM upd UNION ALL SELECT rev FROM ins',
        [t.uid, t.kind, value, revOf(value), baseRev]);
      if (!rows.length) return null;
      return { rev: Number(rows[0].rev) };
    },

    close: () => bridge.close(),
  };
  return driver;
}
