#!/usr/bin/env node
/* Applies every api/migrations/*.sql to the database in DATABASE_URL, in filename order — the
 * migration runner this repo does not have yet (gymbro vercel port, T4c). 0001_init.sql is plain
 * DDL with IF NOT EXISTS on every statement, so running it twice is safe: this is what the CI
 * postgres service runs before the storage integration tests, and what an operator runs before
 * the first boot with STORAGE_DRIVER=postgres.
 *
 *   DATABASE_URL=postgres://user:password@host:5432/dbname node api/scripts/apply-migrations.mjs
 *
 * `psql "$DATABASE_URL" -f api/migrations/0001_init.sql` does the same thing; this script exists
 * because neither a CI runner nor a container image can be assumed to ship psql — node is always
 * there, and the same command then runs identically on every machine. */
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('apply-migrations: DATABASE_URL is not set (postgres://user:password@host:5432/dbname)');
  process.exit(1);
}

// Host and database only, never the password: this line ends up in CI logs.
let target = '(DATABASE_URL)';
try { const u = new URL(url); target = u.host + u.pathname; } catch { /* pg may still accept it */ }

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
if (!files.length) {
  console.error(`apply-migrations: no .sql files under ${MIGRATIONS.pathname}`);
  process.exit(1);
}

// One query, no parameters: pg then uses the simple protocol, which runs the whole file as a
// single implicit transaction — a migration cannot land half applied.
const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  for (const file of files) {
    await client.query(readFileSync(new URL(file, MIGRATIONS), 'utf8'));
    console.log(`  ok    ${file}`);
  }
  console.log(`${files.length} migration(s) applied to ${target}`);
} catch (e) {
  console.error(`  FAIL  ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => { /* the connection may never have opened */ });
}
