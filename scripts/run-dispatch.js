/**
 * Cron entry point. Wire this into the existing isa-call-list scheduler, or run
 * it as a Railway cron service.
 *
 *   node scripts/run-dispatch.js dispatch     # select + dial
 *   node scripts/run-dispatch.js dispatch --dry-run
 *   node scripts/run-dispatch.js reap         # rescue stuck in_flight rows
 *   node scripts/run-dispatch.js rollup       # nightly metrics for the throttle
 *   node scripts/run-dispatch.js status       # print the funnel
 *   node scripts/run-dispatch.js stop "reason"  # EMERGENCY STOP — halt all dialing
 *   node scripts/run-dispatch.js resume         # resume dialing
 *
 * Suggested schedule (America/Los_Angeles), matching the ladder windows:
 *   0 10 * * 1-6   dispatch     # mid-morning
 *   0 16 * * 1-6   dispatch     # late afternoon
 *   0 18 * * 1-5   dispatch     # evening (weekdays only)
 *   0 21 * * *     reap
 *   30 21 * * *    rollup
 */

import pg from 'pg';
import { runDispatch, reapStaleInFlight, nightlyRollup } from '../src/reactivation/dispatcher.js';

const cmd = process.argv[2] || 'status';
const dryRun = process.argv.includes('--dry-run');

async function status(db) {
  const { rows } = await db.query(`SELECT * FROM re_v_cohort_status`);
  console.log('\n  wave  cohort            waiting  in_flight  reached  appts  exhausted  total');
  console.log('  ' + '-'.repeat(76));
  for (const r of rows) {
    console.log(
      `  ${String(r.wave).padStart(4)}  ${String(r.cohort).padEnd(16)}` +
      `${String(r.waiting).padStart(9)}${String(r.in_flight).padStart(11)}` +
      `${String(r.reached).padStart(9)}${String(r.appointments).padStart(7)}` +
      `${String(r.exhausted).padStart(11)}${String(r.total).padStart(7)}`,
    );
  }

  const { rows: rel } = await db.query(
    `SELECT * FROM re_daily_release ORDER BY release_date DESC LIMIT 7`);
  console.log('\n  date        target  pushed  state   reason');
  console.log('  ' + '-'.repeat(76));
  for (const r of rel) {
    console.log(`  ${r.release_date.toISOString().slice(0, 10)}  ` +
      `${String(r.target_dials).padStart(6)}  ${String(r.actual_pushed).padStart(6)}  ` +
      `${String(r.throttle_state).padEnd(7)} ${(r.throttle_reason || '').slice(0, 44)}`);
  }
  console.log('');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

  try {
    switch (cmd) {
      case 'dispatch': {
        const out = await runDispatch(db, { dryRun });
        console.log(JSON.stringify(out));
        break;
      }
      case 'reap':
        await reapStaleInFlight(db);
        break;
      case 'rollup':
        // TODO wire rolloverPct from the existing "[scheduler] rolled N uncalled" counter.
        await nightlyRollup(db, { rolloverPct: null });
        break;
      case 'status':
        await status(db);
        break;

      // ---- emergency stop -------------------------------------------------
      // Takes effect on the very next dispatcher run. No deploy, no Railway
      // access, no cron edit. The reason is recorded so whoever finds it
      // stopped knows why and who did it.
      case 'stop': {
        const reason = process.argv.slice(3).join(' ') || 'manual stop';
        await db.query(
          `INSERT INTO re_control (key, value, note, updated_by, updated_at)
           VALUES ('dialing_enabled', 'false', $1, $2, now())
           ON CONFLICT (key) DO UPDATE
             SET value = 'false', note = $1, updated_by = $2, updated_at = now()`,
          [reason, process.env.USER || process.env.RAILWAY_SERVICE_NAME || 'cli']);
        const { rows: [f] } = await db.query(
          `SELECT count(*)::int AS n FROM re_contact WHERE status = 'in_flight'`);
        console.log(`\n  ⛔ DIALING STOPPED — "${reason}"`);
        console.log(`  No further contacts will be pushed.`);
        console.log(`  ${f.n} already in flight; SimpleTalk may still complete those.`);
        console.log(`  To also stop those, pause the SimpleTalk workflow in GHL.`);
        console.log(`  Resume with: node scripts/run-dispatch.js resume\n`);
        break;
      }

      case 'resume': {
        await db.query(
          `UPDATE re_control SET value = 'true', note = 'resumed', updated_by = $1,
                  updated_at = now() WHERE key = 'dialing_enabled'`,
          [process.env.USER || 'cli']);
        const { rows: [fresh] } = await db.query(`SELECT re_suppression_is_fresh(120) AS ok`);
        console.log(`\n  ✅ Dialing resumed.`);
        console.log(fresh?.ok
          ? `  Suppression sync is fresh — the next cron run will dial.\n`
          : `  ⚠️  Suppression sync is STALE — run sync-suppression.js or dialing stays blocked.\n`);
        break;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        process.exit(2);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
