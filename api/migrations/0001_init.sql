-- gymbro's persistent state on Postgres (vercel port, task T4c).
--
-- Apply once per database, before the first boot with STORAGE_DRIVER=postgres:
--   psql "$DATABASE_URL" -f api/migrations/0001_init.sql
-- Every statement is idempotent, so a retry (or a second instance running it) is safe.
--
-- What changed from the schema drafted in tasks/gymbro-vercel-port.md ("Esquema Postgres
-- propuesto (T4c)"), and why:
--
--   * IF NOT EXISTS everywhere: the migration may be run twice — a retry, or a second
--     instance racing at boot.
--   * `secrets` is NEW: `secret` is a raw string (32 random bytes as hex), not a JSON
--     document, so it cannot sit in `docs` without lying about its shape. It is written with
--     INSERT ... ON CONFLICT DO NOTHING: two instances racing to create it keep exactly one
--     value instead of one instance re-signing every session cookie out from under the other.
--   * `docs.kind` gains db, db-bak, org-bak, coach-config, vapid, integration-outbox and
--     shared-items-bak: the driver maps whole files to rows, and every `.bak` a store writes
--     beside its document (`saveDb`, org-store, library/store) needs a row of its own.
--     Full mapping: api/storage-postgres.js classifyKey().
--   * `docs.rev` MIRRORS the document's own `_rev` (0 when it carries none) instead of
--     counting writes: server.js compares the client's `baseRev` against `_rev` INSIDE the
--     document, so the column must hold that same number or the CAS would refuse a write
--     the read would accept. The column and the jsonb are always updated in one statement,
--     so they cannot drift.
--   * The CAS statement below differs from the drafted `UPDATE ... WHERE rev=$4 RETURNING
--     rev` in one way: a plain UPDATE returns 0 rows also when the ROW DOES NOT EXIST yet,
--     which would answer the very first write with a false conflict. The CTE inserts when
--     baseRev is 0 and no row exists, and does nothing (0 rows = conflict) in every other
--     case, in one round trip and one implicit transaction.
--   * `accounts`, `passkeys` and `media` are created but NOT yet used by the driver:
--     db.json still goes through saveDb() as ONE document (splitting it into accounts and
--     passkeys is a server.js change outside T4c), and media metadata belongs to T5 (the
--     bytes go to Vercel Blob). Creating them now means those steps land without a schema
--     change.

-- Future home of db.json's accounts, once saveDb() is split (driver does not use it yet).
CREATE TABLE IF NOT EXISTS accounts (
  id         text PRIMARY KEY,
  doc        jsonb NOT NULL,
  rev        bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS passkeys (
  id         text PRIMARY KEY,          -- credential id
  uid        text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  doc        jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every JSON document behind the seam's logical keys: state-<uid>.json, watch-<uid>.json,
-- share/<uid>.json, coach/<uid>.json, integrations/u-<uid>.json, and the instance-wide
-- db.json (+ db.json.bak), org.json (+ .bak), coach.json, vapid.json,
-- integrations/outbox.json, shared/items.json (+ .bak), shared/blocklist.json.
CREATE TABLE IF NOT EXISTS docs (
  uid        text NOT NULL,             -- '' for the instance-wide documents
  kind       text NOT NULL,             -- state | watch | share | coach | integration |
                                         -- org | shared-items | shared-blocklist |
                                         -- db | db-bak | org-bak | coach-config | vapid |
                                         -- integration-outbox | shared-items-bak
  doc        jsonb NOT NULL,
  rev        bigint NOT NULL DEFAULT 0, -- mirrors doc's own _rev (0 when it has none)
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, kind)
);

-- The upsert an unconditional write uses (writeJSON / atomicWrite):
--   INSERT INTO docs (uid, kind, doc, rev) VALUES ($1, $2, $3, $4)
--   ON CONFLICT (uid, kind) DO UPDATE SET doc = EXCLUDED.doc, rev = EXCLUDED.rev, updated_at = now();
--
-- The CAS the sync contract needs (swapJSON) — 0 rows returned means conflict, and the
-- caller answers the 409 with the current document it re-reads:
--   WITH upd AS (
--     UPDATE docs SET doc = $3, rev = $4, updated_at = now()
--     WHERE uid = $1 AND kind = $2 AND rev = $5
--     RETURNING rev
--   ), ins AS (
--     INSERT INTO docs (uid, kind, doc, rev)
--     SELECT $1, $2, $3, $4
--     WHERE $5 = 0 AND NOT EXISTS (SELECT 1 FROM upd)
--     ON CONFLICT (uid, kind) DO NOTHING
--     RETURNING rev
--   )
--   SELECT rev FROM upd UNION ALL SELECT rev FROM ins;
-- ($4 is the new revision — the _rev inside the jsonb; $5 is the caller's baseRev.)

-- audit.log as append-only rows: appendLine inserts, compactAudit's rewrite is one
-- transaction (DELETE + the kept rows), never a whole-file rewrite.
CREATE TABLE IF NOT EXISTS audit (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL,
  uid     text,
  entry   jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_uid_at ON audit (uid, at DESC);

-- Metadata for T5: the objects go to Vercel Blob, only the rows live here.
CREATE TABLE IF NOT EXISTS media (
  uid                text NOT NULL,
  hash               text NOT NULL,
  ext                text NOT NULL,
  size               bigint NOT NULL,
  unreferenced_since timestamptz,          -- replaces the grace marks of .gc.json
  put_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (uid, hash)
);

-- `secret` (the key session cookies are signed with), created race-free: the first
-- instance's INSERT wins, every later one changes nothing (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS secrets (
  name       text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
