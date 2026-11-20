// The storage seam: what the API persists, said as domain operations over logical keys
// ("db.json", "state-<uid>.json", "audit.log"), never as paths. The driver behind them is
// chosen once at boot from STORAGE_DRIVER (default `fs`), so moving every caller — db.json,
// per-user state, the audit log, the stores — off the filesystem is a driver swap here and no
// change at the call sites (gymbro vercel port, task T4). An unknown name is a boot error, never
// a silent fallback: an instance that believes it is on Postgres while its bytes land in files
// would lose them on the first container restart.
//
// TWO THINGS HAPPEN HERE, BEFORE ANY DRIVER SEES A KEY, so `fs` and `postgres` receive
// identical inputs (T4c):
//   1. Legacy paths become logical keys: durable.js hands every write over as a full path
//      (path.resolve of its caller's file). A path under DATA_DIR is re-rooted to its key
//      ("DATA_DIR/db.json" → "db.json") exactly once, at this boundary — not in each driver.
//      A path OUTSIDE DATA_DIR is a legacy absolute path the fs driver still honours as given
//      (its contract, tested); a driver without a filesystem refuses it in classifyKey.
//   2. swapJSON is the compare-and-swap the sync contract needs: server.js PUT /api/data does
//      read-compare-write and could only say "atomic for this process". On `postgres` the CAS
//      is a single UPDATE … WHERE rev = $n RETURNING rev (0 rows = conflict → the existing
//      409-with-the-current-document path); on `fs` it is today's in-process comparison, no
//      worse than before. The client contract (baseRev, `_rev` inside the document) unchanged.
//
// The `fs` driver keeps the semantics durable.js had, byte for byte: temporary file, fsync,
// rename, fsync of the directory (that ordering is the contract — see durable.js), the caller's
// mode (0600 on `secret` and db.json) and the `db.json.bak` copy written the same way beside the
// original. A relative key is a logical key and lands under DATA_DIR. An ABSOLUTE key is a full
// path from the one caller that predates the seam (durable.atomicWrite hands those over) and is
// used exactly as given — a driver without a filesystem simply never receives one.
import fs from 'node:fs';
import path from 'node:path';
import { createPostgresDriver } from './storage-postgres.js';

/** Where the fs driver keeps its keys. Read per call, so a test can point it at a temp dir first. */
const dataDir = () => process.env.DATA_DIR || '/data';
const resolve = key => (path.isAbsolute(key) ? key : path.join(dataDir(), key));

/**
 * A legacy full path into the key space: a path under DATA_DIR becomes its logical key
 * (forward slashes on every platform, so the row a write lands in is the row a read asks for),
 * and anything else — a logical key as given, a full path outside DATA_DIR — comes back
 * untouched. Normalised HERE, once, before dispatch; the drivers never see a path they did not
 * agree on.
 */
export function normalizeKey(key) {
  if (typeof key !== 'string' || !path.isAbsolute(key)) return key;
  const rel = path.relative(path.resolve(dataDir()), path.resolve(key));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return key;
  return rel.split(path.sep).join('/');
}

/** fsync of a directory, so a rename inside it is on disk. Best effort: some filesystems refuse. */
function syncDir(dir) {
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch { /* a filesystem that cannot fsync a directory */ }
  finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/** The `_rev` a document carries as a revision, else 0 — the number `rev` columns mirror. */
const revOf = doc => (doc && typeof doc === 'object' && Number.isFinite(doc._rev) ? doc._rev : 0);

const fsDriver = {
  /** `content` at `key`, durably: temporary file, fsync, rename, fsync of the directory. */
  atomicWrite(key, content, mode) {
    const file = resolve(key);
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    if (mode != null) { try { fs.chmodSync(tmp, mode); } catch { /* a host filesystem that refuses chmod */ } }
    fs.renameSync(tmp, file);
    syncDir(path.dirname(file));
  },

  /**
   * The JSON at `key`, or `fallback` when nobody wrote that key yet. A file that exists but does
   * not parse THROWS (SyntaxError): the reader decides what a torn or damaged document means —
   * db.json keeps its `.bak` and refuses to start rather than boot an empty instance (loadDb in
   * server.js), and a missing file with no fallback is `null`, not an exception.
   */
  readJSON(key, fallback = null) {
    let raw;
    try { raw = fs.readFileSync(resolve(key), 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
    return JSON.parse(raw);
  },

  /** `value` as JSON at `key`, durably. `mode` (0600) and `space` (indent 2 for db.json) are what that file had. */
  writeJSON(key, value, mode, space) {
    fsDriver.atomicWrite(key, JSON.stringify(value, null, space), mode);
  },

  /** One more line at the end of `key` (audit.log): a line torn by a crash costs one event, never the file. */
  appendLine(key, line) {
    fs.appendFileSync(resolve(key), line + '\n');
  },

  /** Did anybody write `key`? */
  exists(key) { return fs.existsSync(resolve(key)); },

  /** Size and mtimes of `key`; THROWS with ENOENT when nobody wrote it. */
  stat(key) { return fs.statSync(resolve(key)); },

  /**
   * Compare-and-swap: write `value` only if the document at `key` still reads `baseRev`.
   * Returns `{ rev }` on success and `null` when the base is stale — the signal the caller
   * turns into the 409 with the current document. On a filesystem this is the read-compare-
   * write server.js always did: atomic FOR THIS PROCESS only. Cross-instance safety is what
   * STORAGE_DRIVER=postgres buys (see storage-postgres.js); the contract the seam exposes is
   * the same on both. A key that exists but does not parse THROWS instead of comparing as
   * absent: damage is not "nobody wrote it".
   */
  swapJSON(key, value, baseRev) {
    const cur = fsDriver.readJSON(key, null);
    if (revOf(cur) !== baseRev) return null;
    fsDriver.atomicWrite(key, JSON.stringify(value));
    return { rev: revOf(value) };
  },
};

/**
 * The driver behind the seam. Everything except a known name is a boot error:
 * STORAGE_DRIVER=postgres must not start up writing files where its operator expects rows —
 * and it must not start without DATABASE_URL either, which createPostgresDriver enforces.
 */
export function selectDriver(name = process.env.STORAGE_DRIVER || 'fs') {
  switch (name) {
    case 'fs': return fsDriver;
    case 'postgres': return createPostgresDriver({ url: process.env.DATABASE_URL });
    default: throw new Error(`Unknown STORAGE_DRIVER "${name}": no such storage driver (known: fs, postgres)`);
  }
}

/**
 * A driver plus the seam's two boundaries: legacy paths normalised to logical keys (once,
 * here — never inside a driver) and every operation dispatched by name, with `swapJSON` taking
 * the same validated base revision to every implementation. Built once for the process below;
 * tests build their own over a fake to prove the contract without a database.
 */
export function createSeam(driver) {
  const OPS = ['atomicWrite', 'readJSON', 'writeJSON', 'appendLine', 'exists', 'stat', 'swapJSON'];
  for (const op of OPS) {
    if (typeof driver?.[op] !== 'function') throw new Error(`storage driver does not implement ${op}()`);
  }
  const call = (op, key, ...args) => driver[op](normalizeKey(key), ...args);
  return {
    atomicWrite: (key, content, mode) => call('atomicWrite', key, content, mode),
    readJSON: (key, fallback) => call('readJSON', key, fallback),
    writeJSON: (key, value, mode, space) => call('writeJSON', key, value, mode, space),
    appendLine: (key, line) => call('appendLine', key, line),
    exists: key => call('exists', key),
    stat: key => call('stat', key),
    swapJSON: (key, value, baseRev) => {
      const base = Number(baseRev);
      if (!Number.isInteger(base) || base < 0) {
        throw new TypeError(`swapJSON: baseRev must be a non-negative integer, got ${JSON.stringify(baseRev)}`);
      }
      if (!value || typeof value !== 'object') throw new TypeError('swapJSON: value must be a document');
      return call('swapJSON', key, value, base);
    },
  };
}

// Chosen at load: an unknown value fails the boot (server.js imports durable.js, which imports
// this module) instead of surfacing on the first write after a deploy.
const driver = selectDriver();
const seam = createSeam(driver);

export const atomicWrite = seam.atomicWrite;
export const readJSON = seam.readJSON;
export const writeJSON = seam.writeJSON;
export const appendLine = seam.appendLine;
export const exists = seam.exists;
export const stat = seam.stat;
export const swapJSON = seam.swapJSON;

/** Does the chosen driver speak SQL? Only the postgres one does: it is what keeps upload
 *  metadata in the `media` table (MEDIA_BACKEND=blob, gymbro vercel port T5). The `fs` driver
 *  keeps files and has no rows to ask. */
export const queryAvailable = typeof driver.query === 'function';

/**
 * The one query handle, over the ONE pool the postgres driver already owns — deliberately not a
 * second `createSyncBridge` or `Pool({max:1})` beside it. Callers that need SQL (media.js) get it
 * here; on `fs` this throws a message that says which setting is missing, because MEDIA_BACKEND=blob
 * cannot work without rows and must fail loudly instead of half working.
 */
export const query = (sql, params) => {
  if (!queryAvailable) {
    throw new Error(`MEDIA_BACKEND=blob needs STORAGE_DRIVER=postgres: upload metadata lives in the media table, and STORAGE_DRIVER="${process.env.STORAGE_DRIVER || 'fs'}" has no SQL query handle`);
  }
  return driver.query(sql, params);
};

/**
 * Let the driver go. The postgres bridge runs `pg` on a worker thread, and a worker holds the
 * event loop open — which is exactly what makes the synchronous query possible, and exactly why a
 * test process that queried the pool has to close it or `node --test` never exits. The server
 * never calls this: its listening socket is what keeps it alive.
 */
export const close = () => (typeof driver.close === 'function' ? driver.close() : Promise.resolve());
