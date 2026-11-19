/* The storage seam (api/storage.js): what the API persists is said as domain operations over
   logical keys ("db.json", "state-<uid>.json", "audit.log"), never as paths, so the driver
   behind them can move off the filesystem (Postgres, gymbro vercel port T4) without a single
   caller changing. The driver is picked from STORAGE_DRIVER at load, default `fs`, and an
   unknown name refuses to boot rather than quietly writing files where an operator expects
   rows. The fs driver keeps durable.js's contract byte for byte: temporary file, fsync, rename,
   fsync of the directory — without that order a host reset brought back the file the client had
   been told was replaced (QA 2026-10-06) — plus the caller's mode (0600 on secret and db.json). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = fileURLToPath(new URL('..', import.meta.url));

// The driver is chosen when the module loads, so the default has to be in the environment
// before the first import: whatever this process was given aside, the seam starts on `fs`.
delete process.env.STORAGE_DRIVER;
const storage = await import('../storage.js');

/** DATA_DIR for one test, restored afterwards: the fs driver reads it per call, not at load. */
function withDataDir(t, dir) {
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  t.after(() => { if (prev === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = prev; });
}

test('the seam is driver-shaped: domain operations, no paths', () => {
  const driver = storage.selectDriver('fs');
  for (const op of ['atomicWrite', 'readJSON', 'writeJSON', 'appendLine', 'exists', 'stat']) {
    assert.equal(typeof driver[op], 'function', `the seam exposes ${op}`);
  }
});

test('atomicWrite: a logical key lands under DATA_DIR, bytes flushed, then the rename, then the directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withDataDir(t, dir);
  const calls = [];
  const fdPath = new Map();
  const open = fs.openSync, fsync = fs.fsyncSync, rename = fs.renameSync, chmod = fs.chmodSync;
  t.mock.method(fs, 'openSync', (p, ...rest) => { const fd = open(p, ...rest); fdPath.set(fd, p); return fd; });
  t.mock.method(fs, 'fsyncSync', fd => { calls.push(['fsync', fdPath.get(fd)]); return fsync(fd); });
  t.mock.method(fs, 'chmodSync', (p, m) => { calls.push(['chmod', m]); return chmod(p, m); });
  t.mock.method(fs, 'renameSync', (a, b) => { calls.push(['rename', b]); return rename(a, b); });
  storage.atomicWrite('state-u1.json', '{"_rev":1}', 0o600);
  const file = path.join(dir, 'state-u1.json');
  assert.deepEqual(calls, [['fsync', file + '.tmp'], ['chmod', 0o600], ['rename', file], ['fsync', dir]]);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"_rev":1}');
  assert.equal(fs.existsSync(file + '.tmp'), false, 'the temporary file was renamed away');
});

test('atomicWrite: an absolute key is a legacy full path and is written exactly where its caller says', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-data-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-legacy-'));
  t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true }); });
  withDataDir(t, dataDir);
  const legacy = path.join(elsewhere, 'db.json');
  storage.atomicWrite(legacy, '{"users":[]}', 0o600);
  assert.equal(fs.readFileSync(legacy, 'utf8'), '{"users":[]}');
  assert.equal(fs.existsSync(path.join(dataDir, 'db.json')), false, 'a full path is not re-rooted under DATA_DIR');
  assert.equal(fs.existsSync(path.join(dataDir, legacy + '.tmp')), false);
});

test('writeJSON and readJSON round-trip a logical key; a missing key is the fallback, corrupt JSON throws', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-json-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withDataDir(t, dir);
  const db = { users: [{ id: 'u1' }], creds: [] };
  storage.writeJSON('db.json', db, 0o600, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), JSON.stringify(db, null, 2), 'the spacing the caller had (db.json is indent 2)');
  assert.deepEqual(storage.readJSON('db.json'), db);
  assert.deepEqual(storage.readJSON('no-such-key.json', { fresh: true }), { fresh: true }, 'a key nobody wrote is the fallback');
  assert.equal(storage.readJSON('no-such-key.json'), null, 'the default fallback is null');
  fs.writeFileSync(path.join(dir, 'broken.json'), 'not json at all');
  assert.throws(() => storage.readJSON('broken.json'), SyntaxError, 'a corrupt file is reported, never swallowed');
});

test('appendLine: one call, one more line, and every earlier line untouched', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-append-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withDataDir(t, dir);
  storage.appendLine('audit.log', JSON.stringify({ id: 1, ev: 'signin' }));
  storage.appendLine('audit.log', JSON.stringify({ id: 2, ev: 'signout' }));
  assert.equal(
    fs.readFileSync(path.join(dir, 'audit.log'), 'utf8'),
    '{"id":1,"ev":"signin"}\n{"id":2,"ev":"signout"}\n',
    'one JSON object per line, the shape auditLines() reads back',
  );
});

test('exists and stat: a present key is reported, an absent one is not, and statting it says so', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-stat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  withDataDir(t, dir);
  storage.atomicWrite('secret', '0123456789');
  assert.equal(storage.exists('secret'), true);
  assert.equal(storage.stat('secret').size, 10);
  assert.equal(storage.exists('vapid.json'), false);
  assert.throws(() => storage.stat('vapid.json'), /ENOENT/);
});

test('an unknown STORAGE_DRIVER refuses to boot instead of falling back to the filesystem', () => {
  assert.throws(() => storage.selectDriver('postgres'), /STORAGE_DRIVER "postgres"/, 'the name is rejected, loudly');
  const url = pathToFileURL(path.join(API, 'storage.js')).href;
  const boot = ["process.env.STORAGE_DRIVER = 'blob';", `await import(${JSON.stringify(url)});`].join('\n');
  let stderr = '';
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', boot], { cwd: API, stdio: ['ignore', 'ignore', 'pipe'] });
    assert.fail('the process should have refused to start');
  } catch (e) { stderr = String(e.stderr || ''); }
  assert.match(stderr, /Unknown STORAGE_DRIVER "blob"/, 'the boot error names the variable and the value');
});

test('durable.js hands every write through the seam, resolving its legacy full paths first', () => {
  const durable = fs.readFileSync(path.join(API, 'durable.js'), 'utf8');
  assert.match(durable, /import \{ atomicWrite as storageWrite \} from '\.\/storage\.js';/);
  assert.match(durable, /export function atomicWrite\(file, content, mode\) \{ storageWrite\(path\.resolve\(file\), content, mode\); \}/);
});

/* T4b: the reads themselves go through the seam. A caller that still parses with fs cannot move
   to another driver by swapping storage.js, so the three documents the server serves — the
   per-user state, the watch mailbox and db.json — are read with readJSON over logical keys, and
   the parsed-state cache is keyed by time: a stat key would tie it to the filesystem, because a
   driver behind the seam has no stat to ask. */
test('server.js reads state, watch and db.json through the seam, never with fs itself', () => {
  const server = fs.readFileSync(path.join(API, 'server.js'), 'utf8');
  assert.match(server, /import \{ readJSON \} from '\.\/storage\.js';/);
  // Every reader names the logical key, the key shape a driver without a filesystem can answer.
  assert.ok([...server.matchAll(/readJSON\(stateKey\(uid\), null\)/g)].length >= 2,
    'readState and readStateStrict both read through the seam');
  assert.match(server, /readJSON\(watchKey\(uid\), null\)/);
  assert.match(server, /readJSON\('db\.json', NO_DB\)/);
  assert.match(server, /readJSON\('db\.json\.bak'\)/);
  // Not one fs read of those three documents is left anywhere in the file.
  assert.doesNotMatch(server, /fs\.readFileSync\(stateFile\(/);
  assert.doesNotMatch(server, /fs\.readFileSync\(watchFile\(/);
  assert.doesNotMatch(server, /fs\.readFileSync\(dbFile/);
  // The cache takes its document from the seam and expires by time, never by a file's stat.
  const at = server.indexOf('function readStateCached(');
  assert.notEqual(at, -1, 'readStateCached is the entry point the hot-path routes read through');
  const body = server.slice(at, server.indexOf('\nfunction ', at + 1));
  assert.match(body, /readState\(uid\)/, 'a miss reads through the seam reader');
  assert.match(body, /STATE_CACHE_TTL_MS/, 'entries expire by time');
  assert.doesNotMatch(body, /statSync/, 'a driver without a filesystem has no stat to key on');
});
