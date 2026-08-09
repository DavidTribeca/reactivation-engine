/**
 * Suppression sync.
 *
 * Mirrors FUB's do-not-contact ponds, no-call stages, and active pipeline into
 * re_suppression, and stops anyone already mid-ladder.
 *
 *   node scripts/sync-suppression.js              # incremental (default)
 *   node scripts/sync-suppression.js --full       # full reconciliation scan
 *
 * Cron:
 *   every 15 min   ->  node scripts/sync-suppression.js
 *   daily 03:15    ->  node scripts/sync-suppression.js --full
 *
 * Why frequent: ISAs trash people out of the do-not-contact pond. A trashed
 * person disappears, so a slow sync can miss them entirely and the bot would go
 * on to call someone who asked not to be called. re_suppression is append-only,
 * so once captured a record can never be lost to a later trash.
 *
 * Incremental mode uses FUB's `updatedAfter` filter (verified working). It does
 * NOT use `pondId` — that parameter is silently ignored by the API and returns
 * the entire database. See adapters/fub.js for the full story.
 */

import { makePool } from '../src/reactivation/db.js';
import { syncSuppression, assertSuppressionSane, DNC_POND_IDS, DNC_STAGES, ACTIVE_STAGES }
  from '../src/reactivation/adapters/fub.js';

const FULL = process.argv.includes('--full');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  if (!process.env.FUB_API_KEY) throw new Error('FUB_API_KEY is not set');

  const db = makePool({ max: 4 });
  const before = Number((await db.query(`SELECT count(*)::int n FROM re_suppression`)).rows[0].n);

  console.log(`[sync] mode=${FULL ? 'full' : 'incremental'} ` +
    `ponds=[${DNC_POND_IDS}] dncStages=${DNC_STAGES.length} activeStages=${ACTIVE_STAGES.length}`);

  let result = null, error = null;
  try {
    result = await syncSuppression(db, { mode: FULL ? 'full' : 'incremental' });
    // Refuse to trust a result that wants to suppress a big share of the base.
    assertSuppressionSane(result);
  } catch (err) {
    error = err.message;
    console.error(`[sync] FAILED: ${err.message}`);
  }

  const after = Number((await db.query(`SELECT count(*)::int n FROM re_suppression`)).rows[0].n);
  const stopped = Number((await db.query(
    `SELECT count(*)::int n FROM re_contact WHERE status='suppressed'`)).rows[0].n);

  // Only stamp last_ok_at on success — the dispatcher reads it and refuses to
  // dial when suppression is stale.
  const ok = !error;
  await db.query(
    `INSERT INTO re_sync_state (key, last_run_at, last_ok_at, ok, detail)
     VALUES ('suppression', now(), CASE WHEN $1 THEN now() END, $1, $2)
     ON CONFLICT (key) DO UPDATE
       SET last_run_at = now(),
           last_ok_at  = CASE WHEN $1 THEN now() ELSE re_sync_state.last_ok_at END,
           ok = $1, detail = $2`,
    [ok, error || `${FULL ? 'full' : 'incremental'}: +${after - before} suppressions`],
  );

  console.log(JSON.stringify({
    mode: FULL ? 'full' : 'incremental',
    suppression_before: before,
    suppression_after: after,
    newly_suppressed: after - before,
    contacts_stopped_total: stopped,
    result, error,
  }, null, 2));

  await db.end();
  if (error) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
