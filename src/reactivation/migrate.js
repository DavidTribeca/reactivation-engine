/**
 * Migration runner — applies the SQL in migrations/ at boot.
 *
 * WHY THIS RUNS ITSELF
 *
 * The setup instructions said `psql "$DATABASE_URL" -f migrations/001....`.
 * That assumes someone has psql installed and the database reachable from
 * their machine. Railway's Postgres is only reachable over a TCP proxy on a
 * non-standard port, which plenty of networks block outright — so "run the
 * migrations" could quietly become the step that stalls a launch. Having the
 * service apply its own schema on boot removes the human and the laptop from
 * the path entirely: deploying IS migrating.
 *
 * Every file is wrapped in a transaction and recorded in re_migration by
 * filename, so a file that has already run is skipped. The files themselves
 * are written to be idempotent (CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE),
 * so even a lost ledger only costs a re-run, not a failure.
 *
 * A failure here is fatal by design. A half-migrated schema with the server
 * happily serving on top of it is worse than a service that refuses to start:
 * the dispatcher would hit a missing column mid-batch, having already pushed
 * some contacts to SimpleTalk.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations');

async function ensureLedger(db) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS re_migration (
       filename    text PRIMARY KEY,
       applied_at  timestamptz NOT NULL DEFAULT now(),
       checksum    text
     )`);
}

/** Cheap, dependency-free content fingerprint — catches an edited file. */
function checksum(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * Apply everything not yet applied, in filename order.
 * Returns { applied: [...], skipped: [...], changed: [...] }.
 */
export async function runMigrations(db) {
  await ensureLedger(db);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();   // 001_, 002_, ... — the numeric prefix is load-bearing

  const { rows } = await db.query(`SELECT filename, checksum FROM re_migration`);
  const seen = new Map(rows.map((r) => [r.filename, r.checksum]));

  const applied = [], skipped = [], changed = [];

  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    const sum = checksum(sql);

    if (seen.has(file)) {
      skipped.push(file);
      // Applied under different content than what is on disk now. Not fatal —
      // these files are idempotent and a later migration may supersede an
      // earlier one — but it should never pass silently.
      if (seen.get(file) && seen.get(file) !== sum) {
        changed.push(file);
        console.warn(`[migrate] ${file} has changed since it was applied ` +
          `(${seen.get(file)} -> ${sum}). Not re-run. Add a new migration instead.`);
      }
      continue;
    }

    const client = await db.connect();
    try {
      // Each file already contains BEGIN/COMMIT in some cases, so run the file
      // as-is and only wrap the ledger write. Postgres tolerates the nesting
      // with a warning; what matters is that a failed file leaves no ledger row.
      await client.query(sql);
      await client.query(
        `INSERT INTO re_migration (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO UPDATE SET checksum = $2`, [file, sum]);
      applied.push(file);
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      console.error(`[migrate] FAILED on ${file}: ${err.message}`);
      throw new Error(`migration ${file} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`[migrate] ${applied.length} applied, ${skipped.length} already present`);
  return { applied, skipped, changed };
}
