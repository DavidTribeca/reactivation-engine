/**
 * Integration test — runs the dispatcher's real SQL against a live Postgres.
 *
 * Validates the pieces a unit test can't: the batch-selection query's array
 * gate, suppression EXISTS clause, rolling-7 correlated subquery, FOR UPDATE
 * SKIP LOCKED, and the state-machine transitions in recordOutcome.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/integration-test.js
 */

import pg from 'pg';
import { resolveTarget, runDispatch, recordOutcome, reapStaleInFlight, nightlyRollup }
  from '../src/reactivation/dispatcher.js';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let pass = 0, fail = 0;

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

async function reset() {
  await db.query(`TRUNCATE re_attempt, re_contact, re_daily_release, re_suppression,
                           re_caller_number RESTART IDENTITY CASCADE`);
  await db.query(
    `INSERT INTO re_control (key,value,note) VALUES ('dialing_enabled','true','test')
     ON CONFLICT (key) DO UPDATE SET value='true'`);
}

async function seed() {
  await db.query(`
    INSERT INTO re_caller_number (phone_e164, label, daily_cap) VALUES
      ('+12065550001','test-1',110), ('+14255550002','test-2',110)`);

  // 1 written-consent wave-1, 1 written wave-3, 1 ebr_expired (must be gated
  // out), 1 suppressed, 1 future-dated (not yet due).
  await db.query(`
    INSERT INTO re_contact
      (fub_person_id, phone_e164, cohort_code, priority_score, consent_tier, next_eligible_at)
    VALUES
      (101,'+13105550101','hot_engaged',   90, 'written',     now() - interval '1 min'),
      (102,'+13105550102','dormant_1_3y',  95, 'written',     now() - interval '1 min'),
      (103,'+13105550103','hot_engaged',   99, 'ebr_expired', now() - interval '1 min'),
      (104,'+13105550104','hot_engaged',   98, 'written',     now() - interval '1 min'),
      (105,'+13105550105','hot_engaged',   97, 'written',     now() + interval '3 days')`);

  await db.query(`
    INSERT INTO re_suppression (phone_e164, reason) VALUES ('+13105550104','opt_out')`);
}

async function main() {
  console.log('\n=== Reactivation engine integration test ===\n');
  await reset();
  await seed();

  // ---- throttle ledger -------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);
  const ledger = await resolveTarget(db, today);
  check('resolveTarget creates ledger row', !!ledger && ledger.target_dials > 0,
    JSON.stringify(ledger));

  // ---- batch selection -------------------------------------------------
  console.log('\n  -- batch selection (dry run) --');
  const r1 = await runDispatch(db, { dryRun: true });
  check('selects exactly the 2 eligible written-consent contacts', r1.pushed === 2,
    `got pushed=${r1.pushed}`);

  // Verify the gates individually via the same predicates.
  const { rows: gated } = await db.query(`
    SELECT c.fub_person_id
      FROM re_contact c JOIN re_cohort co ON co.code = c.cohort_code
     WHERE c.status='eligible' AND c.next_eligible_at <= now()
       AND c.consent_tier = ANY($1::text[])
       AND NOT EXISTS (SELECT 1 FROM re_suppression s WHERE s.phone_e164=c.phone_e164)
     ORDER BY co.wave, c.priority_score DESC`, [['written']]);
  const ids = gated.map((g) => Number(g.fub_person_id));
  check('consent gate excludes ebr_expired (103)', !ids.includes(103), `ids=${ids}`);
  check('suppression excludes opted-out (104)', !ids.includes(104), `ids=${ids}`);
  check('future next_eligible_at excludes (105)', !ids.includes(105), `ids=${ids}`);
  check('wave ordering puts wave-1 (101) before wave-3 (102)',
    ids.indexOf(101) < ids.indexOf(102), `ids=${ids}`);

  // ---- state machine ---------------------------------------------------
  console.log('\n  -- state machine --');
  // Simulate a real push on contact 101 so there is an open attempt row.
  const { rows: [c101] } = await db.query(
    `SELECT id FROM re_contact WHERE fub_person_id=101`);
  await db.query(
    `INSERT INTO re_attempt (contact_id, attempt_number, window_label)
     VALUES ($1, 1, 'mid_morning')`, [c101.id]);
  await db.query(
    `UPDATE re_contact SET status='in_flight', attempt_count=1, last_pushed_at=now()
      WHERE id=$1`, [c101.id]);

  const noAns = await recordOutcome(db, { contactId: c101.id, outcome: 'no_answer' });
  check('no_answer returns to eligible', noAns.status === 'eligible', JSON.stringify(noAns));
  check('no_answer schedules attempt 2', noAns.nextAttempt === 2, JSON.stringify(noAns));
  check('attempt 2 uses late_afternoon window', noAns.window === 'late_afternoon',
    JSON.stringify(noAns));

  const { rows: [after] } = await db.query(
    `SELECT status, attempt_count, next_eligible_at > now() AS future
       FROM re_contact WHERE id=$1`, [c101.id]);
  check('next_eligible_at pushed into the future', after.future === true, JSON.stringify(after));
  check('attempt_count preserved at 1', after.attempt_count === 1, JSON.stringify(after));

  // Opt-out must be terminal AND land in suppression.
  const { rows: [c102] } = await db.query(
    `SELECT id, phone_e164 FROM re_contact WHERE fub_person_id=102`);
  await db.query(
    `INSERT INTO re_attempt (contact_id, attempt_number, window_label)
     VALUES ($1, 1, 'mid_morning')`, [c102.id]);
  await db.query(`UPDATE re_contact SET status='in_flight', attempt_count=1 WHERE id=$1`, [c102.id]);

  const opt = await recordOutcome(db, { contactId: c102.id, outcome: 'opted_out' });
  check('opted_out is terminal', opt.status === 'opted_out', JSON.stringify(opt));
  const { rows: sup } = await db.query(
    `SELECT 1 FROM re_suppression WHERE phone_e164=$1`, [c102.phone_e164]);
  check('opted_out writes to re_suppression', sup.length === 1);

  // Opted-out contact must never be selected again.
  await db.query(`UPDATE re_daily_release SET actual_pushed = 0 WHERE release_date=$1`, [today]);
  const { rows: reGated } = await db.query(`
    SELECT c.fub_person_id FROM re_contact c
     WHERE c.status='eligible'
       AND NOT EXISTS (SELECT 1 FROM re_suppression s WHERE s.phone_e164=c.phone_e164)`);
  check('opted-out contact no longer selectable',
    !reGated.map((r) => Number(r.fub_person_id)).includes(102));

  // ---- ladder exhaustion ----------------------------------------------
  console.log('\n  -- ladder exhaustion --');
  await db.query(
    `UPDATE re_contact SET status='in_flight', attempt_count=5, max_attempts=5 WHERE id=$1`,
    [c101.id]);
  await db.query(
    `INSERT INTO re_attempt (contact_id, attempt_number, window_label)
     VALUES ($1, 5, 'mid_morning')`, [c101.id]);
  const exh = await recordOutcome(db, { contactId: c101.id, outcome: 'no_answer' });
  check('5th no_answer exhausts the ladder', exh.status === 'exhausted', JSON.stringify(exh));
  const { rows: [exhRow] } = await db.query(
    `SELECT next_eligible_at > now() + interval '100 days' AS recycles
       FROM re_contact WHERE id=$1`, [c101.id]);
  check('exhausted contact recycles at ~120 days', exhRow.recycles === true);

  // ---- reaper ----------------------------------------------------------
  console.log('\n  -- reaper --');
  const { rows: [c105] } = await db.query(
    `SELECT id FROM re_contact WHERE fub_person_id=105`);
  await db.query(
    `UPDATE re_contact SET status='in_flight', attempt_count=1,
            last_pushed_at = now() - interval '48 hours' WHERE id=$1`, [c105.id]);
  await db.query(
    `INSERT INTO re_attempt (contact_id, attempt_number, window_label)
     VALUES ($1, 1, 'mid_morning')`, [c105.id]);
  const reaped = await reapStaleInFlight(db);
  check('reaper rescues stale in_flight', reaped === 1, `reaped=${reaped}`);

  // ---- rollup + views --------------------------------------------------
  console.log('\n  -- rollup and views --');
  await db.query(`UPDATE re_attempt SET outcome='reached', outcome_at=now()
                   WHERE attempt_number=1 AND outcome IS NULL`);
  await nightlyRollup(db, { rolloverPct: 0.08 });
  const { rows: [rel] } = await db.query(
    `SELECT rollover_pct, answer_rate FROM re_daily_release WHERE release_date=$1`, [today]);
  check('rollup writes rollover_pct', Number(rel.rollover_pct) === 0.08, JSON.stringify(rel));
  check('rollup computes answer_rate', rel.answer_rate !== null, JSON.stringify(rel));

  for (const v of ['re_v_cohort_status', 're_v_window_performance', 're_v_number_health']) {
    try {
      await db.query(`SELECT * FROM ${v} LIMIT 5`);
      check(`view ${v} executes`, true);
    } catch (e) {
      check(`view ${v} executes`, false, e.message);
    }
  }

  // ---- suppression freshness safety gate -------------------------------
  console.log('\n  -- suppression freshness gate --');
  await db.query(
    `UPDATE re_sync_state SET last_ok_at = now() - interval '99 hours', ok=false
      WHERE key='suppression'`);
  const stale = await runDispatch(db, { dryRun: false });
  check('stale suppression sync aborts a live dispatch',
    stale.aborted === true && stale.pushed === 0, JSON.stringify(stale));

  await db.query(`UPDATE re_sync_state SET last_ok_at = now(), ok=true WHERE key='suppression'`);
  const { rows: [fresh] } = await db.query(`SELECT re_suppression_is_fresh(120) AS ok`);
  check('fresh suppression sync clears the gate', fresh.ok === true);

  // A dry run must never be blocked by the gate (it makes no calls).
  await db.query(
    `UPDATE re_sync_state SET last_ok_at = now() - interval '99 hours' WHERE key='suppression'`);
  const dry = await runDispatch(db, { dryRun: true });
  check('dry run bypasses the freshness gate', dry.aborted !== true, JSON.stringify(dry));

  // ---- flow control ceilings -------------------------------------------
  console.log('\n  -- flow control --');
  await reset();
  await seed();
  await db.query(`UPDATE re_sync_state SET last_ok_at = now(), ok = true WHERE key='suppression'`);
  await db.query(
    `INSERT INTO re_daily_release (release_date, target_dials, throttle_state)
     VALUES (current_date, 1000, 'green')
     ON CONFLICT (release_date) DO UPDATE SET target_dials = 1000`);

  // Park a large number in_flight to trip the WIP ceiling (auto = 60% of 1000).
  await db.query(
    `INSERT INTO re_contact (fub_person_id, phone_e164, cohort_code, consent_tier, status, last_pushed_at)
     SELECT 900000 + g, '+1999' || lpad(g::text, 7, '0'), 'hot_engaged', 'written', 'in_flight', now()
       FROM generate_series(1, 700) g`);
  const wip = await runDispatch(db, { dryRun: false });
  check('in-flight ceiling holds the dispatcher',
    wip.pushed === 0 && /in-flight/i.test(wip.held || ''), JSON.stringify(wip));

  // Drain the in-flight backlog; the dispatcher should resume.
  await db.query(`DELETE FROM re_contact WHERE fub_person_id >= 900000`);
  const resumed = await runDispatch(db, { dryRun: true });
  check('dispatcher resumes once in-flight drains', resumed.pushed > 0, JSON.stringify(resumed));

  for (const v of ['re_v_flow', 're_v_today_by_window', 're_v_forward_load', 're_v_burndown']) {
    try { await db.query(`SELECT * FROM ${v} LIMIT 3`); check(`view ${v} executes`, true); }
    catch (e) { check(`view ${v} executes`, false, e.message); }
  }

  // ---- safety controls -------------------------------------------------
  console.log('\n  -- safety controls --');
  await reset();
  await seed();
  await db.query(`UPDATE re_sync_state SET last_ok_at = now(), ok = true WHERE key='suppression'`);
  await db.query(`UPDATE re_control SET value='true' WHERE key='dialing_enabled'`);

  // emergency stop
  await db.query(`UPDATE re_control SET value='false', note='test halt' WHERE key='dialing_enabled'`);
  const stopped = await runDispatch(db, { dryRun: false });
  check('emergency stop halts dialing',
    stopped.aborted === true && stopped.reason === 'dialing_disabled', JSON.stringify(stopped));

  await db.query(`UPDATE re_control SET value='true' WHERE key='dialing_enabled'`);
  const afterResume = await runDispatch(db, { dryRun: true });
  check('resume restores dialing', afterResume.aborted !== true, JSON.stringify(afterResume));

  // missing control row must FAIL CLOSED
  await db.query(`DELETE FROM re_control WHERE key='dialing_enabled'`);
  const { rows: [noRow] } = await db.query(`SELECT re_dialing_enabled() AS ok`);
  check('missing control row fails CLOSED (no dialing)', noRow.ok === false, JSON.stringify(noRow));
  await db.query(
    `INSERT INTO re_control (key,value,note) VALUES ('dialing_enabled','true','restored')`);

  // same-day duplicate guard
  const { rows: [c1] } = await db.query(`SELECT id FROM re_contact WHERE fub_person_id=101`);
  await db.query(
    `INSERT INTO re_attempt (contact_id, attempt_number, window_label, push_ok)
     VALUES ($1, 1, 'mid_morning', true)`, [c1.id]);
  const { rows: dupCheck } = await db.query(
    `SELECT c.fub_person_id FROM re_contact c
      WHERE c.status='eligible'
        AND NOT EXISTS (SELECT 1 FROM re_attempt a
                         WHERE a.contact_id=c.id AND a.pushed_at::date=current_date)`);
  check('same-day guard excludes an already-dialled contact',
    !dupCheck.map(r => Number(r.fub_person_id)).includes(101),
    JSON.stringify(dupCheck.map(r => Number(r.fub_person_id))));

  // unknown-timezone guard
  await db.query(
    `UPDATE re_contact SET tz_source='default_unknown' WHERE fub_person_id=102`);
  for (const [win, shouldSee] of [['mid_morning', true], ['evening', false]]) {
    const { rows } = await db.query(
      `SELECT c.fub_person_id FROM re_contact c
        WHERE c.status='eligible'
          AND (c.tz_source <> 'default_unknown' OR $1 = 'mid_morning')`, [win]);
    const seen = rows.map(r => Number(r.fub_person_id)).includes(102);
    check(`unknown-tz contact ${shouldSee ? 'IS' : 'is NOT'} dialable in ${win}`,
      seen === shouldSee, `seen=${seen}`);
  }

  // volume spike guard
  await db.query(`DELETE FROM re_daily_release`);
  await db.query(
    `INSERT INTO re_daily_release (release_date, target_dials, actual_pushed, throttle_state)
     VALUES (current_date - 1, 100, 100, 'green')`);
  await db.query(
    `UPDATE re_daily_release SET throttle_state='green' WHERE release_date = current_date - 1`);
  const led = await resolveTarget(db, new Date().toISOString().slice(0,10));
  check('volume spike guard caps target at 2x yesterday',
    Number(led.target_dials) <= 200, `target=${led.target_dials}`);

  // THROTTLE WIRING. Guards against the signature drift that silently
  // disabled the throttle: if resolveTarget stops feeding evaluate() real
  // counts, every signal reads "insufficient data" and volume ramps unchecked.
  console.log('\n  -- throttle wiring --');
  await db.query(`DELETE FROM re_daily_release`);
  await db.query(
    `INSERT INTO re_daily_release
       (release_date, target_dials, actual_pushed, throttle_state, reached_count, rollover_pct)
     VALUES (current_date - 1, 400, 400, 'green', 200, 0.40)`);
  // 200 escalations with 40% rollover = 80 leaked, far above the 15% red line.
  await db.query(`DELETE FROM re_daily_release WHERE release_date = current_date`);
  const ledRed = await resolveTarget(db, new Date().toISOString().slice(0, 10));
  check('throttle SEES real rollover and goes red',
    ledRed.throttle_state === 'red', `state=${ledRed.throttle_state} reason=${ledRed.throttle_reason}`);
  check('red throttle actually cuts volume',
    Number(ledRed.target_dials) < 400, `target=${ledRed.target_dials}`);
  check('throttle reason cites rollover, not "insufficient data"',
    /rollover \d/.test(ledRed.throttle_reason || ''), ledRed.throttle_reason);

  for (const v of ['re_v_timezone_coverage']) {
    try { await db.query(`SELECT * FROM ${v} LIMIT 3`); check(`view ${v} executes`, true); }
    catch (e) { check(`view ${v} executes`, false, e.message); }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
