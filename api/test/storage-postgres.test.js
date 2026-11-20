/* The postgres driver (api/storage-postgres.js, gymbro vercel port T4c): what the seam's keys
   become when STORAGE_DRIVER=postgres — one row per document in `docs`, audit entries as rows in
   `audit`, `secret` as an insert-if-absent row — plus the synchronous bridge that lets a driver
   with a synchronous contract talk to an asynchronous client without changing a single call site
   in server.js.

   Three layers, no Docker needed for the first two:
   1. classifyKey: every legacy key the API writes maps to exactly ONE row, and a key with no
      mapping is an error, never a silent no-op (a lost write would look like a saved one).
   2. createSyncBridge: answered synchronously here by an echo worker, so the request/reply
      protocol, the error path and the timeout are proven without a database.
   3. The real database: skipped unless STORAGE_TEST_DATABASE_URL is set. This machine has no
      Docker, so the real-postgres run is a CI job with `services: postgres`; the other tests
      need nothing but node. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = fileURLToPath(new URL('..', import.meta.url));

/* An echo worker for the bridge: same protocol as the real one (reply file, then the flag in
   shared memory), no database. HANG never answers, so the timeout path can be timed. */
const ECHO_SOURCE = `
(async () => {
  const { parentPort, workerData } = await import('node:worker_threads');
  const fs = await import('node:fs');
  const flags = new Int32Array(workerData.sab);
  const answer = (msg, payload) => {
    try { fs.writeFileSync(msg.replyTo, JSON.stringify(payload)); } catch { /* the caller times out */ }
    Atomics.store(flags, 0, 1);
    Atomics.notify(flags, 0);
  };
  parentPort.on('message', msg => {
    if (msg.sql === 'HANG') return;
    if (msg.sql === 'FAIL') return answer(msg, { ok: false, message: 'boom', code: 'XX000' });
    answer(msg, { ok: true, rows: [{ echo: msg.params }] });
  });
})();
`;

test('every key the API writes maps to exactly one row', async () => {
  const { classifyKey } = await import('../storage-postgres.js');
  const doc = (uid, kind) => ({ table: 'docs', uid, kind });
  const cases = [
    // state, watch, share, coach, integrations: per profile
    ['state-u_1.json', doc('u_1', 'state')],
    ['watch-u2.json', doc('u2', 'watch')],
    ['share/u_trainer.json', doc('u_trainer', 'share')],
    ['coach/u3.json', doc('u3', 'coach')],
    ['integrations/u-u4.json', doc('u4', 'integration')],
    // the instance-wide documents (saveDb, the stores, the outbox)
    ['db.json', doc('', 'db')],
    ['db.json.bak', doc('', 'db-bak')],
    ['org.json', doc('', 'org')],
    ['org.json.bak', doc('', 'org-bak')],
    ['coach.json', doc('', 'coach-config')],
    ['vapid.json', doc('', 'vapid')],
    ['integrations/outbox.json', doc('', 'integration-outbox')],
    ['shared/items.json', doc('', 'shared-items')],
    ['shared/items.json.bak', doc('', 'shared-items-bak')],
    ['shared/blocklist.json', doc('', 'shared-blocklist')],
    // the same library under the name the feature doc lists it by
    ['library/shared/items.json', doc('', 'shared-items')],
    ['library/shared/items.json.bak', doc('', 'shared-items-bak')],
    ['library/shared/blocklist.json', doc('', 'shared-blocklist')],
    // rows that are not documents
    ['audit.log', { table: 'audit' }],
    ['secret', { table: 'secrets', name: 'secret' }],
  ];
  for (const [key, expected] of cases) {
    assert.deepEqual(classifyKey(key), expected, `key ${JSON.stringify(key)}`);
  }
});

test('a key postgres cannot store is an error, never a silent no-op', async () => {
  const { classifyKey } = await import('../storage-postgres.js');
  assert.throws(() => classifyKey('uploads/u1/deadbeef.png'), /no row mapping/,
    'a media byte path belongs to Blob, and must not pretend to be stored');
  assert.throws(() => classifyKey('vapid.json.bak'), /no row mapping/);
  assert.throws(() => classifyKey(''), /no row mapping/);
  // A legacy full path outside DATA_DIR survives normalisation on purpose (the fs driver honours
  // it); a driver without a filesystem has nowhere to put it and says so instead of guessing.
  assert.throws(() => classifyKey(path.join(API, 'server.js')), /not a logical key/);
  assert.throws(() => classifyKey(path.join('/data', 'anything.json')), /not a logical key/);
});

test('the driver demands DATABASE_URL, and never opens a connection to say so', async () => {
  const { createPostgresDriver } = await import('../storage-postgres.js');
  assert.throws(() => createPostgresDriver({}), /DATABASE_URL/, 'no connection string, no driver');
  assert.throws(() => createPostgresDriver({ url: '' }), /DATABASE_URL/);
  // With a URL the driver is constructed but idle: the worker (and the pool) starts on the
  // first query, so importing server.js with STORAGE_DRIVER=postgres cannot dial mid-boot.
  const driver = createPostgresDriver({ url: 'postgres://user:pass@example.invalid:5432/gym' });
  await driver.close();
});

test('the bridge answers in the calling thread, carries errors across, and times out on silence', async () => {
  const { createSyncBridge } = await import('../storage-postgres.js');
  const bridge = createSyncBridge({ source: ECHO_SOURCE, timeoutMs: 5000 });
  try {
    assert.deepEqual(bridge.query('ECHO', [{ a: 1 }]), [{ echo: [{ a: 1 }] }],
      'the caller blocks until the worker replies, and gets the rows back');
    assert.throws(() => bridge.query('FAIL', []), e => e.message === 'boom' && e.code === 'XX000',
      'a failure in the worker surfaces as an error here, not as a hang');
    const impatient = createSyncBridge({ source: ECHO_SOURCE, timeoutMs: 100 });
    assert.throws(() => impatient.query('HANG', []), /no reply/,
      'a worker that never answers fails the query instead of freezing the server forever');
    await impatient.close();
  } finally {
    await bridge.close();
  }
});

/* The real database. CI runs this with `services: postgres` and STORAGE_TEST_DATABASE_URL set;
   locally (no Docker on this machine) it is skipped by name, not by accident. */
const PG_URL = process.env.STORAGE_TEST_DATABASE_URL;
const MIGRATIONS = path.join(API, 'migrations', '0001_init.sql');

test('real postgres: round-trip, CAS conflict, audit rows and the secret race', {
  skip: !PG_URL && 'set STORAGE_TEST_DATABASE_URL (CI services: postgres) to run',
}, async t => {
  const { createSyncBridge, createPostgresDriver } = await import('../storage-postgres.js');
  const pgUrl = import.meta.resolve('pg');
  const workerData = { url: PG_URL, pgUrl };

  const setup = createSyncBridge({ workerData });
  try { setup.query(fs.readFileSync(MIGRATIONS, 'utf8')); } finally { await setup.close(); }

  const a = createPostgresDriver({ url: PG_URL });
  const b = createPostgresDriver({ url: PG_URL });
  t.after(() => Promise.allSettled([a.close(), b.close()]));
  const uid = 'itest_' + Date.now();
  t.after(async () => {
    const bridge = createSyncBridge({ workerData });
    try {
      bridge.query('DELETE FROM docs WHERE uid = $1', [uid]);
      bridge.query('DELETE FROM audit WHERE uid = $1', [uid]);
      bridge.query("DELETE FROM secrets WHERE name = 'secret'");
    } finally { await bridge.close(); }
  });

  const key = `state-${uid}.json`;
  // Round trip: write, read back, and the `_rev` inside the jsonb is what the column mirrors.
  a.writeJSON(key, { _rev: 1, workouts: [] }, 0o600);
  assert.deepEqual(a.readJSON(key, null), { _rev: 1, workouts: [] });
  assert.equal(a.exists(key), true);
  assert.ok(a.stat(key).size > 0, 'the row reports a size, so stat keeps its shape');

  // CAS: the first writer with the current base revision wins, the second gets nothing.
  assert.deepEqual(a.swapJSON(key, { _rev: 2, workouts: [{ d: '2026-11-19' }] }, 1), { rev: 2 });
  assert.equal(b.swapJSON(key, { _rev: 2, workouts: [] }, 1), null, '0 rows: the stale writer is refused');
  assert.deepEqual(b.swapJSON(key, { _rev: 3, workouts: [] }, 2), { rev: 3 }, 'merged, then accepted');
  assert.equal(a.readJSON(key, null)._rev, 3, 'both instances read the same document');
  assert.equal(a.swapJSON(key, { _rev: 99, workouts: [] }, 1), null, 'a writer quoting an old base never lands');
  assert.equal(a.readJSON(key, null)._rev, 3, 'and the document is untouched by the refused write');

  // audit.log: append-only rows, not a rewritten blob.
  a.appendLine('audit.log', JSON.stringify({ id: 1, ev: 'signin', uid }));
  b.appendLine('audit.log', JSON.stringify({ id: 2, ev: 'signout', uid }));
  const bridge = createSyncBridge({ workerData });
  try {
    const counted = bridge.query('SELECT count(*) AS n FROM audit WHERE uid = $1', [uid]);
    assert.equal(Number(counted[0].n), 2, 'two instances appended two rows, neither overwrote');

    // secret: whichever instance creates it first wins, the loser's bytes are discarded.
    bridge.query("DELETE FROM secrets WHERE name = 'secret'");
    a.atomicWrite('secret', '"aaaa"', 0o600);
    b.atomicWrite('secret', '"bbbb"', 0o600);
    assert.equal(a.readJSON('secret'), 'aaaa', 'the first creator won');
    assert.equal(b.readJSON('secret'), 'aaaa', 'the second instance reads the first one back');
  } finally { await bridge.close(); }
});
