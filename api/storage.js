// The storage seam: what the API persists, said as domain operations over logical keys
// ("db.json", "state-<uid>.json", "audit.log"), never as paths. The driver behind them is
// chosen once at boot from STORAGE_DRIVER (default `fs`), so moving every caller — db.json,
// per-user state, the audit log, the stores — off the filesystem is a driver swap here and no
// change at the call sites (gymbro vercel port, task T4). An unknown name is a boot error, never
// a silent fallback: an instance that believes it is on Postgres while its bytes land in files
// would lose them on the first container restart.
//
// The `fs` driver keeps the semantics durable.js had, byte for byte: temporary file, fsync,
// rename, fsync of the directory (that ordering is the contract — see durable.js), the caller's
// mode (0600 on `secret` and db.json) and the `db.json.bak` copy written the same way beside the
// original. A relative key is a logical key and lands under DATA_DIR. An ABSOLUTE key is a full
// path from the one caller that predates the seam (durable.atomicWrite hands those over) and is
// used exactly as given — a driver without a filesystem simply never receives one.
import fs from 'node:fs';
import path from 'node:path';

/** Where the fs driver keeps its keys. Read per call, so a test can point it at a temp dir first. */
const dataDir = () => process.env.DATA_DIR || '/data';
const resolve = key => (path.isAbsolute(key) ? key : path.join(dataDir(), key));

/** fsync of a directory, so a rename inside it is on disk. Best effort: some filesystems refuse. */
function syncDir(dir) {
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); }
  catch { /* a filesystem that cannot fsync a directory */ }
  finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

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
};

/**
 * The driver behind the seam. Everything except a known name is a boot error:
 * STORAGE_DRIVER=postgres must not start up writing files where its operator expects rows.
 */
export function selectDriver(name = process.env.STORAGE_DRIVER || 'fs') {
  switch (name) {
    case 'fs': return fsDriver;
    default: throw new Error(`Unknown STORAGE_DRIVER "${name}": no such storage driver (known: fs)`);
  }
}

// Chosen at load: an unknown value fails the boot (server.js imports durable.js, which imports
// this module) instead of surfacing on the first write after a deploy.
const driver = selectDriver();

export const atomicWrite = (key, content, mode) => driver.atomicWrite(key, content, mode);
export const readJSON = (key, fallback) => driver.readJSON(key, fallback);
export const writeJSON = (key, value, mode, space) => driver.writeJSON(key, value, mode, space);
export const appendLine = (key, line) => driver.appendLine(key, line);
export const exists = key => driver.exists(key);
export const stat = key => driver.stat(key);
