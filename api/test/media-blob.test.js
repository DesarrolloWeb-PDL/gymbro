/* T5 on Vercel Blob (gymbro vercel port): what changes when MEDIA_BACKEND=blob takes over, and
   what must NOT change.

   The bytes go to Blob, so no stored file keeps a local copy: an upload streams through the
   staging folder exactly as before (hash, magic sniff, MP4 box walk, the 507 floor) and then
   lands in Blob, with a row in the `media` table as the only truth afterwards. Everything the fs
   backend answers from readdir and .gc.json — who has what, how much space, when it stopped being
   referenced — is answered from rows here.

   Two things this file exists to pin, because both fail silently if they regress:

   - `coalesce(sum(size),0)` comes back from Postgres as `numeric`, i.e. a STRING through the
     sync bridge (only `bigint` is parsed to a Number). Left uncoerced, `e.bytes + need >
     quotaBytes` concatenates instead of adding and refuses an upload that fits.
   - A delete cannot be awaited — every caller of sweep/removeUser/dropFile is synchronous — so it
     runs as "row marked `deleting` first, bytes after, row last". A failed delete must leave a row
     that is already invisible and gets retried, never billed bytes with nothing to say they must
     go.

   Real PostgreSQL, no Docker: the database is created here (gymbro_ prefixed, never touched
   otherwise) and the migrations are applied to it. Without a reachable server every test that
   needs it skips — the same rule api/test/storage-postgres.test.js follows. There is no Blob
   token and no emulator on this machine, so the byte store is an honest in-memory fake and the
   REAL @vercel/blob calls are what a Vercel preview deploy has to prove. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import * as M from './media-samples.mjs';

const API = fileURLToPath(new URL('..', import.meta.url));
const quiet = { warn() {}, error() {}, log() {} };
const DAY = 86400000;
const START = 1800000000000;

/* ---------- the database ---------- */

const DB = 'gymbro_media';
const MAINT = process.env.STORAGE_TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/postgres';
const withDb = url => { const u = new URL(url); u.pathname = `/${DB}`; return u.toString(); };
const TARGET = withDb(MAINT);

async function prepare() {
  const admin = new pg.Client({ connectionString: MAINT, connectionTimeoutMillis: 4000 });
  await admin.connect();
  try {
    const has = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
    if (!has.rows.length) await admin.query(`CREATE DATABASE "${DB}"`);
  } finally { await admin.end(); }
  const mig = new pg.Client({ connectionString: TARGET, connectionTimeoutMillis: 4000 });
  await mig.connect();
  try {
    // Both, in order: 0001 is the schema, 0002 adds the `deleting` flag the delete protocol runs on.
    for (const f of ['0001_init.sql', '0002_media_deleting.sql']) {
      await mig.query(fs.readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
    }
  } finally { await mig.end(); }
}

let ready = false;
let why = 'no PostgreSQL reachable';
try {
  await prepare();
  ready = true;
} catch (e) {
  why = `no PostgreSQL for the media-blob tests (${String(e.message).split('\n')[0]})`;
}

// Before any app module loads: media.js reads MEDIA_BACKEND and the storage seam reads
// STORAGE_DRIVER at import time, and ESM runs a file's static imports before its body.
let media = null;
let seam = null;
if (ready) {
  process.env.MEDIA_BACKEND = 'blob';
  process.env.STORAGE_DRIVER = 'postgres';
  process.env.DATABASE_URL = TARGET;
  media = await import('../media.js');
  seam = await import('../storage.js');
  assert.equal(seam.queryAvailable, true, 'the postgres driver exposes the pool');
}
const blobmod = await import('../storage-blob.js');

// The bridge's worker holds the event loop open (that is how the synchronous query works), so the
// file has to let go of it or `node --test` would never finish.
after(() => (ready ? seam.close() : Promise.resolve()));

const SKIP = ready ? false : why;
const q = (sql, params) => seam.query(sql, params);

/* ---------- an honest fake Blob ---------- */

function fakeBytes() {
  const store = new Map();
  const state = { failDel: false };
  return {
    state,
    store,
    async put(pathname, localPath) { store.set(pathname, fs.readFileSync(localPath)); },
    async download(pathname, localPath) {
      const b = store.get(pathname);
      if (!b) throw Object.assign(new Error(`no blob at ${pathname}`), { code: 'ENOENT' });
      fs.writeFileSync(localPath, b, { mode: 0o600, flag: 'wx' });
    },
    async del(pathnames) {
      // A real del is an HTTP call: it does not finish inside the caller's stack, which is the
      // whole reason a delete has to be two-step.
      await new Promise(r => setImmediate(r));
      if (state.failDel) throw new Error('blob store unavailable');
      for (const p of pathnames) store.delete(p);
    },
    stream(pathname) {
      const b = store.get(pathname);
      if (!b) {
        const dead = new Readable({ read() {} });
        process.nextTick(() => dead.destroy(Object.assign(new Error(`no blob at ${pathname}`), { code: 'ENOENT' })));
        return dead;
      }
      return Readable.from([b]);
    },
  };
}

// The delete runs after the answer (it is fire-and-forget by design): let its microtasks and the
// row DELETE behind them land.
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };

function setup(t, limits = {}, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-blob-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'uploads');
  const bytes = fakeBytes();
  const uid = `u_${crypto.randomUUID().slice(0, 8)}`;
  const S = new Map();
  const clock = { t: START };
  t.after(() => { try { q('DELETE FROM media WHERE uid = $1', [uid]); } catch { /* already gone */ } });
  const store = media.createMediaStore({
    dir, limits: { ...media.mediaLimits({}), minFreeMB: 0, ...limits },
    backend: 'blob', bytes, log: quiet, now: () => clock.t, readState: id => S.get(id) ?? null,
    ...opts,
  });
  const rows = () => q('SELECT hash, ext, size, deleting, unreferenced_since FROM media WHERE uid = $1 ORDER BY hash', [uid]);
  const row = hash => rows().find(r => r.hash === hash);
  const files = () => { try { return fs.readdirSync(path.join(dir, uid)).filter(n => !n.startsWith('.')); } catch { return []; } };
  return { dir, uid, store, bytes, S, clock, rows, row, files };
}
const ref = (...hashes) => ({ customEx: hashes.map((h, i) => ({ id: 'cx' + i, n: 'x', bp: 'back', custom: true, media: { kind: 'image', hash: h, mime: 'image/jpeg', size: 1, width: 1, height: 1, at: 1 } })) });

/* ---------- the settings themselves (no database needed) ---------- */

test('an unknown MEDIA_BACKEND refuses to start; it never falls back to fs', () => {
  assert.equal(blobmod.selectMediaBackend('fs'), 'fs');
  assert.equal(blobmod.selectMediaBackend('blob'), 'blob');
  assert.throws(() => blobmod.selectMediaBackend('s3'), /Unknown MEDIA_BACKEND "s3"/);
  assert.throws(() => blobmod.selectMediaBackend(''), /Unknown MEDIA_BACKEND ""/);
});

test('a bad MEDIA_BACKEND fails the boot of media.js instead of storing files locally', () => {
  const url = f => pathToFileURL(path.join(API, f)).href;
  const run = (script, env) => spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: API, encoding: 'utf8', env });
  const clean = extra => { const e = { ...process.env, ...extra }; if (!('MEDIA_BACKEND' in extra)) delete e.MEDIA_BACKEND; return e; };

  // With nothing set the default is fs: a self-hosted install must not need to know Blob exists.
  const dflt = run(`process.stdout.write((await import(${JSON.stringify(url('storage-blob.js'))})).MEDIA_BACKEND)`, clean({}));
  assert.equal(dflt.status, 0, dflt.stderr);
  assert.equal(dflt.stdout, 'fs');

  const bad = run(`await import(${JSON.stringify(url('media.js'))})`, clean({ MEDIA_BACKEND: 's3' }));
  assert.notEqual(bad.status, 0, 'the process must not start');
  assert.match(bad.stderr, /Unknown MEDIA_BACKEND "s3"/);
  // blob without the postgres driver: the metadata would have nowhere to live.
  const noRows = run(`await import(${JSON.stringify(url('media.js'))})`, clean({ MEDIA_BACKEND: 'blob', STORAGE_DRIVER: 'fs' }));
  assert.notEqual(noRows.status, 0, 'the process must not start');
  assert.match(noRows.stderr, /MEDIA_BACKEND=blob needs STORAGE_DRIVER=postgres/);
});

/* ---------- upload, read back, quota ---------- */

test('an upload lands in Blob and in the row, and file() streams it back with no path', { skip: SKIP }, async t => {
  const h = setup(t);
  const bytes = M.jpeg(5000);
  const hash = M.sha(bytes);
  const r = await h.store.receive(h.uid, hash, M.fakeReq(bytes));
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { ok: true, hash, mime: 'image/jpeg', size: 5000, existed: false });

  assert.deepEqual([...h.bytes.store.keys()], [`uploads/${h.uid}/${hash}.jpg`], 'the bytes went to Blob under uploads/<uid>/<hash>.<ext>');
  assert.deepEqual(h.files(), [], 'no local copy of a stored file survives the upload');
  const [stored] = h.rows();
  assert.deepEqual([stored.hash, stored.ext, stored.size, stored.deleting], [hash, 'jpg', 5000, false]);

  const f = h.store.file(h.uid, hash);
  assert.equal(f.path, undefined, 'a Blob-backed file has no local path to serve');
  assert.equal(f.mime, 'image/jpeg');
  assert.equal(f.size, 5000);
  const chunks = [];
  for await (const c of f.stream()) chunks.push(c);
  assert.deepEqual(Buffer.concat(chunks), bytes, 'the stream carries exactly what was uploaded');
});

test('quota sums the rows as a NUMBER: an upload that fits is accepted, one that does not is refused', { skip: SKIP }, async t => {
  // 2500 bytes of quota. With sum(size) left as the string Postgres returns, `e.bytes + need`
  // concatenates instead of adding and the SECOND upload would be refused by a quota it fits.
  const h = setup(t, { quotaMB: 2500 / 1048576 });
  const first = M.jpeg(1000), second = M.jpeg(1000), third = M.jpeg(2000);
  assert.equal((await h.store.receive(h.uid, M.sha(first), M.fakeReq(first))).status, 201);
  assert.strictEqual(typeof h.store.usage(h.uid).bytes, 'number', 'sum(size) must not cross the bridge as a string');
  assert.deepEqual(h.store.usage(h.uid), { bytes: 1000, count: 1, quotaBytes: 2500 });

  assert.equal((await h.store.receive(h.uid, M.sha(second), M.fakeReq(second))).status, 201, '1000 + 1000 fits in 2500');
  assert.equal(h.store.usage(h.uid).bytes, 2000);

  await assert.rejects(h.store.receive(h.uid, M.sha(third), M.fakeReq(third)),
    e => e instanceof media.MediaError && e.status === 413 && e.code === 'media-quota');
  assert.equal(h.store.usage(h.uid).bytes, 2000, 'the refused upload stored nothing');
  assert.deepEqual(h.rows().map(r => r.size), [1000, 1000]);
});

test('the grace marks move to unreferenced_since: set, cleared when referenced, set again', { skip: SKIP }, async t => {
  const h = setup(t);
  const a = M.jpeg(), b = M.jpeg(2000);
  const ha = M.sha(a), hb = M.sha(b);
  await h.store.receive(h.uid, ha, M.fakeReq(a));
  await h.store.receive(h.uid, hb, M.fakeReq(b));
  assert.ok(h.rows().every(r => r.unreferenced_since), 'a new upload is unreferenced until the state that names it arrives');

  assert.equal(h.store.noteState(h.uid, ref(hb)), true, 'the referenced one loses its mark');
  assert.equal(h.row(ha).unreferenced_since !== null, true, 'the unreferenced one keeps it');
  assert.equal(h.row(hb).unreferenced_since, null);

  h.clock.t += DAY;
  assert.equal(h.store.noteState(h.uid, ref(hb)), false, 'an existing mark keeps its time');
  assert.equal(Date.parse(h.row(ha).unreferenced_since), START);
  assert.equal(h.store.noteState(h.uid, ref(ha, hb)), true);
  assert.ok(h.rows().every(r => r.unreferenced_since === null), 'back in the state: no mark left');
});

/* ---------- the delete protocol ---------- */

test('a swept file is gone from the app at once and from Blob and the table right after', { skip: SKIP }, async t => {
  const h = setup(t);
  const keep = M.jpeg(), drop = M.jpeg(3000);
  const keepHash = M.sha(keep), dropHash = M.sha(drop);
  await h.store.receive(h.uid, keepHash, M.fakeReq(keep));
  await h.store.receive(h.uid, dropHash, M.fakeReq(drop));
  h.S.set(h.uid, ref(keepHash));
  h.store.noteState(h.uid, ref(keepHash));

  h.clock.t += 14 * DAY - 1;
  assert.deepEqual(h.store.sweep(h.uid), { removed: 0, freedBytes: 0, skipped: false }, 'a day short of the grace');

  h.clock.t += 1;
  assert.deepEqual(h.store.sweep(h.uid), { removed: 1, freedBytes: 3000, skipped: false });
  assert.equal(h.store.file(h.uid, dropHash), null, 'already invisible: the row says deleting');
  assert.equal(h.store.has(h.uid, dropHash), false);
  assert.deepEqual(h.store.usage(h.uid), { bytes: 1000, count: 1, quotaBytes: 200 * 1048576 }, 'the quota does not count a file on its way out');
  assert.ok(h.bytes.store.has(`uploads/${h.uid}/${dropHash}.jpg`), 'the bytes are not gone until the delete lands');

  await settle();
  assert.deepEqual(h.rows().map(r => r.hash), [keepHash], 'the row goes once its blob does');
  assert.equal(h.bytes.store.has(`uploads/${h.uid}/${dropHash}.jpg`), false, 'and the blob goes with it');
  assert.ok(h.store.file(h.uid, keepHash), 'the referenced file is untouched');
});

test('a Blob delete that fails leaves the row deleting, invisible, and the next sweep heals it', { skip: SKIP }, async t => {
  const h = setup(t);
  const bytes = M.jpeg();
  const hash = M.sha(bytes);
  await h.store.receive(h.uid, hash, M.fakeReq(bytes));
  h.S.set(h.uid, ref());
  h.store.noteState(h.uid, ref());
  h.clock.t += 14 * DAY;

  h.bytes.state.failDel = true;
  assert.equal(h.store.sweep(h.uid, { graceMs: 0 }).removed, 1);
  await settle();
  const [row] = h.rows();
  assert.equal(row.deleting, true, 'the row stays until its blob is gone');
  assert.ok(h.bytes.store.has(`uploads/${h.uid}/${hash}.jpg`), 'the bytes are still there — and still billed');
  assert.equal(h.store.file(h.uid, hash), null, 'invisible all the same');
  assert.equal(h.store.usage(h.uid).bytes, 0, 'and out of the quota');
  assert.equal(h.store.missing(h.uid, [hash]).missing.length, 1, 'a device is told to send it again');

  h.bytes.state.failDel = false;
  h.store.sweepAll({ uids: [h.uid], graceMs: 0 });
  await settle();
  assert.deepEqual(h.rows(), [], 'the retry finishes the job');
  assert.equal(h.bytes.store.has(`uploads/${h.uid}/${hash}.jpg`), false);
});

test('dropFile and removeUser mark the rows first and the bytes follow', { skip: SKIP }, async t => {
  const h = setup(t);
  const a = M.jpeg(), b = M.jpeg(2000), c = M.jpeg(3000);
  const ha = M.sha(a), hb = M.sha(b), hc = M.sha(c);
  await h.store.receive(h.uid, ha, M.fakeReq(a));
  await h.store.receive(h.uid, hb, M.fakeReq(b));
  await h.store.receive('u_other', hc, M.fakeReq(c));
  t.after(() => { try { q('DELETE FROM media WHERE uid = $1', ['u_other']); } catch { /* gone */ } });

  // library/moderation.js calls dropFile synchronously, inside a loop.
  assert.equal(h.store.dropFile(h.uid, ha), true);
  assert.equal(h.store.file(h.uid, ha), null, 'gone from the app before the bytes move');
  await settle();
  assert.deepEqual(h.rows().map(r => r.hash), [hb]);
  assert.equal(h.bytes.store.has(`uploads/${h.uid}/${ha}.jpg`), false);

  h.store.removeUser(h.uid);
  assert.equal(h.store.file(h.uid, hb), null);
  await settle();
  assert.deepEqual(h.rows(), [], 'every row of the profile is gone');
  assert.equal(h.bytes.store.has(`uploads/${h.uid}/${hb}.jpg`), false);
  assert.ok(h.bytes.store.has(`uploads/u_other/${hc}.jpg`), 'another profile is untouched');
});

/* ---------- what the library sharing needs from a Blob-backed file ---------- */

test('materialize hands the library a local copy it can release, without leaving one behind', { skip: SKIP }, async t => {
  const h = setup(t);
  const bytes = M.jpeg(4000);
  const hash = M.sha(bytes);
  await h.store.receive(h.uid, hash, M.fakeReq(bytes));

  const m = await h.store.materialize(h.uid, hash);
  assert.equal(path.basename(path.dirname(m.path)), '.tmp', 'the copy lives in the staging folder');
  assert.deepEqual(fs.readFileSync(m.path), bytes, 'checkShareable gets the real bytes to scrub');
  assert.deepEqual(h.files(), [], 'nothing was copied into the folder the store lists');
  m.release();
  assert.equal(fs.existsSync(m.path), false, 'release() takes it away again');
  await assert.rejects(h.store.materialize(h.uid, 'f'.repeat(64)), e => e instanceof media.MediaError && e.status === 404);
});

/* ---------- the parts of the old behaviour that had to survive ---------- */

test('the 507 disk floor still applies — to the staging directory, not to Blob', { skip: SKIP }, async t => {
  const h = setup(t, { minFreeMB: 1e9 });
  const bytes = M.jpeg();
  await assert.rejects(h.store.receive(h.uid, M.sha(bytes), M.fakeReq(bytes)),
    e => e instanceof media.MediaError && e.status === 507 && e.code === 'storage-full');
  assert.equal(h.bytes.store.size, 0, 'nothing reached Blob');
  assert.deepEqual(h.rows(), [], 'and no row was written');
  assert.deepEqual(h.files(), [], 'the staging file went with the refusal');
});

test('a file that does not hash to its name is refused before anything durable is written', { skip: SKIP }, async t => {
  const h = setup(t);
  const bytes = M.jpeg();
  await assert.rejects(h.store.receive(h.uid, 'f'.repeat(64), M.fakeReq(bytes)),
    e => e instanceof media.MediaError && e.status === 400 && e.code === 'hash-mismatch');
  assert.equal(h.bytes.store.size, 0);
  assert.deepEqual(h.rows(), []);
  assert.deepEqual(h.files(), []);
});

test('a second device asking for a file it already has is answered from the rows', { skip: SKIP }, async t => {
  const h = setup(t);
  const bytes = M.jpeg(1500);
  const hash = M.sha(bytes);
  assert.deepEqual(h.store.missing(h.uid, [hash]).missing, [hash], 'nothing stored yet');
  await h.store.receive(h.uid, hash, M.fakeReq(bytes));
  assert.deepEqual(h.store.missing(h.uid, [hash]), { missing: [], usage: { bytes: 1500, count: 1, quotaBytes: 200 * 1048576 } });
  assert.equal(h.store.has(h.uid, hash), true);
  // The same bytes again: answered as already there, stored once.
  const again = await h.store.receive(h.uid, hash, M.fakeReq(bytes));
  assert.deepEqual([again.status, again.body], [200, { ok: true, hash, mime: 'image/jpeg', size: 1500, existed: true }]);
  assert.deepEqual(h.rows().map(r => r.size), [1500]);
});
