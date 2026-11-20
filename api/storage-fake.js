// The fake driver: the storage seam's contract as a Map, for unit tests (gymbro vercel port,
// T4c). It exists so the contract can be proven WITHOUT a database — and it is built to FAIL
// the way Postgres fails: a compare-and-swap with a stale base revision returns nothing and
// writes nothing, so a test can only pass if the code under test survives losing a race. A fake
// that always says yes would prove the shape of the calls and nothing else.
//
// Two drivers can share one store (`createFakeDriver(a.store)`): that is two instances of the
// API over one database, which is exactly the situation a file cannot express and the reason
// the seam needs a CAS operation at all.
//
// Parity notes, so a test written against the fake means something against `fs` and `postgres`:
//   * `secret` is insert-if-absent (INSERT ... ON CONFLICT DO NOTHING on Postgres): the second
//     instance racing to create it DISCARDS its own value instead of overwriting the first.
//   * `audit.log` is rows: appendLine pushes one entry, an atomicWrite REPLACES them all (the
//     shape compactAudit's retention rewrite has), and readJSON refuses it as a document.
//   * A document's `rev` mirrors the jsonb's own `_rev` (0 when it carries none) — the number
//     server.js compares `baseRev` against — so the CAS sees what a reader sees.
//   * readJSON parses `secret` like fs does: a hex secret is not valid JSON and throws
//     SyntaxError, never returns something a caller did not write.

const revOf = doc => (doc && typeof doc === 'object' && Number.isFinite(doc._rev) ? doc._rev : 0);

const ENOENT = key => Object.assign(new Error(`ENOENT: no such document, stat '${key}'`), { code: 'ENOENT' });

/**
 * A driver over a Map. Pass an existing `store` to a second call and both drivers read and
 * write the same "database" — two instances, one truth.
 */
export function createFakeDriver(store = new Map()) {
  const raw = key => {
    const rec = store.get(key);
    if (!rec) return null;
    if (rec.type === 'text') return rec.text;
    if (rec.type === 'doc') return JSON.stringify(rec.doc);
    return rec.entries.length ? rec.entries.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
  };

  const auditOf = key => {
    let rec = store.get(key);
    if (!rec) { rec = { type: 'audit', entries: [] }; store.set(key, rec); }
    return rec;
  };

  // The one place a line becomes a row: parsed if it parses (uid and ts come off the entry
  // itself, exactly as the driver's SQL columns do), kept raw if it does not.
  const entryOf = line => {
    try { return JSON.parse(line); } catch { return { raw: String(line) }; }
  };

  const driver = {
    /** Test surface: the "database" behind this instance (share it to model two instances). */
    store,
    /** Test surface: the stored value as text — a document as JSON, `secret` verbatim, the audit rows as lines. */
    raw,

    atomicWrite(key, content, mode) {
      if (key === 'audit.log') {
        const rec = auditOf(key);
        rec.entries = String(content).split('\n').filter(Boolean).map(entryOf);
        return;
      }
      if (key === 'secret') {
        // The race: the first creator wins, the loser's bytes are discarded, not written.
        if (!store.has(key)) store.set(key, { type: 'text', text: String(content) });
        return;
      }
      const doc = JSON.parse(content);   // a non-JSON document is refused at the write, as on Postgres
      store.set(key, { type: 'doc', doc, rev: revOf(doc) });
    },

    readJSON(key, fallback = null) {
      const rec = store.get(key);
      if (!rec) return fallback;
      if (rec.type === 'text') return JSON.parse(rec.text);   // fs parity: a hex secret throws SyntaxError
      if (rec.type === 'doc') return structuredClone(rec.doc);
      throw new Error('audit.log is stored as rows, not as one JSON document');
    },

    writeJSON(key, value, mode, space) {
      if (key === 'audit.log') throw new Error('audit.log is rows: use appendLine');
      if (key === 'secret') { store.set(key, { type: 'text', text: JSON.stringify(value) }); return; }
      store.set(key, { type: 'doc', doc: structuredClone(value), rev: revOf(value) });
    },

    appendLine(key, line) {
      if (key !== 'audit.log') throw new Error(`appendLine is for audit.log, not ${JSON.stringify(key)}`);
      auditOf(key).entries.push(entryOf(line));
    },

    exists(key) { return store.has(key); },

    stat(key) {
      if (!store.has(key)) throw ENOENT(key);
      return { size: Buffer.byteLength(raw(key)), mtimeMs: Date.now() };
    },

    swapJSON(key, value, baseRev) {
      if (key === 'audit.log' || key === 'secret') {
        throw new Error(`${JSON.stringify(key)} has no revision to compare against`);
      }
      const cur = store.get(key);
      const curRev = cur && cur.type === 'doc' ? cur.rev : 0;   // nobody wrote it: revision 0
      if (curRev !== baseRev) return null;                      // 0 rows: the racing write is refused
      const doc = structuredClone(value);
      const rev = revOf(doc);
      store.set(key, { type: 'doc', doc, rev });
      return { rev };
    },
  };
  return driver;
}
