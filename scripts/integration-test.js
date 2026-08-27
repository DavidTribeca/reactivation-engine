/**
 * Integration test — runs the dispatcher's real SQL against a live Postgres.
 *
 * Validates the pieces a unit test can't: the batch-selection query's array
 * gate, suppression EXISTS clause, rolling-7 correlated subquery, FOR UPDATE
 * SKIP LOCKED, and the state-machine transitions in recordOutcome.
 *
 * Usage: DATABASE_URL=postgres://... node scripts/integration-test.js
 */

import { makePool, programDate, TZ } from '../src/reactivation/db.js';
import { ROLLOVER_GOVERNS } from '../src/reactivation/throttle.js';
import { resolveTarget, runDispatch, recordOutcome, reapStaleInFlight, nightlyRollup }
  from '../src/reactivation/dispatcher.js';
import { currentWindowLabel, isWithinDialWindow, localWallTimeToUtc, localParts }
  from '../src/reactivation/ladder.js';
import { DISPATCH_SLOTS } from '../src/reactivation/schedule.js';
import { measureRolloverPct } from '../src/reactivation/adapters/isa-list.js';
import { reconcileOutcomes, resolveLink } from '../src/reactivation/reconcile.js';

const db = makePool();
let pass = 0, fail = 0;

/**
 * One fixed instant for the whole run, so the dial-path tests do not depend on
 * what time it happens to be. Two of them used to fail whenever the suite ran
 * outside 8am-8pm Pacific: the dispatcher selected the right contacts and then
 * discarded every one of them at the out-of-hours check, which reads as a
 * selection bug and is not one.
 *
 * mid_morning, 11:00 Pacific — the first window of a production day, and the
 * only one an unknown-timezone contact is allowed into. Sunday is a no-dial
 * day, so a Sunday run steps back to Saturday and gets saturday_am instead.
 * Everything the suite keys on the program day uses TODAY, derived from this
 * same instant, so the ledger stays self-consistent either way.
 */
function fixedDialInstant() {
  const base = localParts(new Date(), TZ);
  for (let back = 0; back < 3; back++) {
    const d = new Date(Date.UTC(base.year, base.month - 1, base.day - back));
    const t = localWallTimeToUtc({
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: 11,
    }, TZ);
    if (currentWindowLabel(t, TZ) && isWithinDialWindow(t, TZ)) return t;
  }
  throw new Error('no dialable day found within 3 days — check WINDOWS/BLOCKED_DOW');
}

const NOW = fixedDialInstant();
const TODAY = programDate(NOW);

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
  //
  // tz_source is set explicitly rather than left to the column default. It is a
  // compliance gate — 'default_unknown' restricts a contact to mid_morning — so
  // a suite that inherits it by accident tests a different query than the one
  // production runs. The unknown-tz case is exercised deliberately further down.
  await db.query(`
    INSERT INTO re_contact
      (fub_person_id, phone_e164, cohort_code, priority_score, consent_tier, next_eligible_at, tz_source)
    VALUES
      (101,'+13105550101','hot_engaged',   90, 'written',     now() - interval '1 min', 'area_code'),
      (102,'+13105550102','dormant_1_3y',  95, 'written',     now() - interval '1 min', 'area_code'),
      (103,'+13105550103','hot_engaged',   99, 'ebr_expired', now() - interval '1 min', 'area_code'),
      (104,'+13105550104','hot_engaged',   98, 'written',     now() - interval '1 min', 'area_code'),
      (105,'+13105550105','hot_engaged',   97, 'written',     now() + interval '3 days', 'area_code')`);

  await db.query(`
    INSERT INTO re_suppression (phone_e164, reason) VALUES ('+13105550104','opt_out')`);
}

/**
 * REFUSE TO RUN AGAINST PRODUCTION.
 *
 * This suite TRUNCATEs every re_* table and creates and drops a stand-in
 * `contacts` table. Against the shared Railway Postgres that would destroy the
 * ISA working queue — the real `contacts` table, with the conversations your
 * ISAs are working right now. Point DATABASE_URL at a scratch database.
 *
 * The check is "does a `contacts` table exist with rows in it", because that is
 * the specific thing this suite would wreck, and an empty scratch database
 * cannot trip it.
 */
async function refuseIfProduction() {
  const { rows: [t] } = await db.query(
    `SELECT to_regclass('public.contacts') IS NOT NULL AS present`);
  if (!t.present) return;

  const { rows: [c] } = await db.query(`SELECT count(*)::int AS n FROM contacts`);
  if (c.n === 0) return;

  const { rows: [db_] } = await db.query(`SELECT current_database() AS name`);
  console.error(
    `\n  ✗ REFUSING TO RUN.\n` +
    `    Database "${db_.name}" has a contacts table with ${c.n} rows — this looks\n` +
    `    like the live ISA queue. This suite truncates tables and would destroy it.\n` +
    `    Point DATABASE_URL at a scratch database instead.\n`);
  await db.end();
  process.exit(2);
}

async function main() {
  console.log('\n=== Reactivation engine integration test ===\n');
  await refuseIfProduction();
  await reset();
  await seed();

  // ---- program day -----------------------------------------------------
  // JavaScript and Postgres must agree on what "today" is. When they did not,
  // the 18:00 Pacific dispatch filed its dials against the next day's ledger
  // row, so no day's actual_pushed was ever the number that actually went out
  // and the throttle ramped off a figure missing an evening. Nothing errored.
  console.log('\n  -- program day --');
  const { rows: [pd] } = await db.query(
    `SELECT current_setting('TimeZone') AS tz, current_date::text AS today`);
  check('pool sessions run in the program timezone', pd.tz === TZ, `tz=${pd.tz}`);
  check('Postgres current_date matches programDate()', pd.today === programDate(),
    `sql=${pd.today} js=${programDate()} utc=${new Date().toISOString().slice(0, 10)}`);

  // ---- schedule vs windows ---------------------------------------------
  // Every scheduled dispatch must land inside a real dial window, in summer and
  // in winter. The afternoon job used to run on Saturdays, when the only window
  // closes at 13:00 — those dials went out in no window and were logged as
  // 'saturday_am'. Checked against a real July week and a real January week so
  // a DST-only failure cannot hide.
  console.log('\n  -- schedule vs dial windows --');
  let slotProblems = [];
  for (const [label, monday] of [['summer', '2026-07-06'], ['winter', '2027-01-11']]) {
    const [y, m, d] = monday.split('-').map(Number);
    for (const slot of DISPATCH_SLOTS) {
      for (const dow of slot.dows) {
        const inst = localWallTimeToUtc(
          { year: y, month: m, day: d + (dow - 1), hour: slot.hour }, TZ);
        const win = currentWindowLabel(inst, TZ);
        if (!win || !isWithinDialWindow(inst, TZ)) {
          slotProblems.push(`${label} ${slot.name} dow=${dow} ${slot.hour}:00 -> ${win || 'NONE'}`);
        }
      }
    }
  }
  check('every scheduled dispatch lands inside a dial window',
    slotProblems.length === 0, slotProblems.join(' | '));
  check('no dispatch is scheduled on a Sunday',
    DISPATCH_SLOTS.every((s) => !s.dows.includes(0)),
    JSON.stringify(DISPATCH_SLOTS.map((s) => s.dows)));

  // ---- throttle ledger -------------------------------------------------
  const ledger = await resolveTarget(db, TODAY);
  check('resolveTarget creates ledger row', !!ledger && ledger.target_dials > 0,
    JSON.stringify(ledger));

  // ---- batch selection -------------------------------------------------
  console.log('\n  -- batch selection (dry run) --');
  const r1 = await runDispatch(db, { dryRun: true, now: NOW });
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
  await db.query(`UPDATE re_daily_release SET actual_pushed = 0 WHERE release_date=$1`, [TODAY]);
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
  // Pin the attempts to the same program day the ledger row is keyed to.
  // The rollup buckets by pushed_at::date, and on a Sunday the fixed instant
  // steps back to Saturday while the database clock still says Sunday — so
  // attempts stamped now() would fall in a different bucket than the ledger
  // row and every metric would compute against zero rows. Real dispatches
  // cannot drift this way, because both sides come from the same instant.
  await db.query(`UPDATE re_attempt SET pushed_at = $1::timestamptz`, [NOW.toISOString()]);
  await nightlyRollup(db, { rolloverPct: 0.08, now: NOW });
  const { rows: [rel] } = await db.query(
    `SELECT rollover_pct, answer_rate FROM re_daily_release WHERE release_date=$1`, [TODAY]);
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
  const stale = await runDispatch(db, { dryRun: false, now: NOW });
  check('stale suppression sync aborts a live dispatch',
    stale.aborted === true && stale.pushed === 0, JSON.stringify(stale));

  await db.query(`UPDATE re_sync_state SET last_ok_at = now(), ok=true WHERE key='suppression'`);
  const { rows: [fresh] } = await db.query(`SELECT re_suppression_is_fresh(120) AS ok`);
  check('fresh suppression sync clears the gate', fresh.ok === true);

  // A dry run must never be blocked by the gate (it makes no calls).
  await db.query(
    `UPDATE re_sync_state SET last_ok_at = now() - interval '99 hours' WHERE key='suppression'`);
  const dry = await runDispatch(db, { dryRun: true, now: NOW });
  check('dry run bypasses the freshness gate', dry.aborted !== true, JSON.stringify(dry));

  // ---- flow control ceilings -------------------------------------------
  console.log('\n  -- flow control --');
  await reset();
  await seed();
  await db.query(`UPDATE re_sync_state SET last_ok_at = now(), ok = true WHERE key='suppression'`);
  await db.query(
    `INSERT INTO re_daily_release (release_date, target_dials, throttle_state)
     VALUES ($1::date, 1000, 'green')
     ON CONFLICT (release_date) DO UPDATE SET target_dials = 1000`, [TODAY]);

  // Park a large number in_flight to trip the WIP ceiling (auto = 60% of 1000).
  await db.query(
    `INSERT INTO re_contact (fub_person_id, phone_e164, cohort_code, consent_tier, status, last_pushed_at)
     SELECT 900000 + g, '+1999' || lpad(g::text, 7, '0'), 'hot_engaged', 'written', 'in_flight', now()
       FROM generate_series(1, 700) g`);
  const wip = await runDispatch(db, { dryRun: false, now: NOW });
  check('in-flight ceiling holds the dispatcher',
    wip.pushed === 0 && /in-flight/i.test(wip.held || ''), JSON.stringify(wip));

  // Drain the in-flight backlog; the dispatcher should resume.
  await db.query(`DELETE FROM re_contact WHERE fub_person_id >= 900000`);
  const resumed = await runDispatch(db, { dryRun: true, now: NOW });
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
  const stopped = await runDispatch(db, { dryRun: false, now: NOW });
  check('emergency stop halts dialing',
    stopped.aborted === true && stopped.reason === 'dialing_disabled', JSON.stringify(stopped));

  await db.query(`UPDATE re_control SET value='true' WHERE key='dialing_enabled'`);
  const afterResume = await runDispatch(db, { dryRun: true, now: NOW });
  check('resume restores dialing', afterResume.aborted !== true, JSON.stringify(afterResume));

  // Out-of-hours must abort with a reason rather than select a batch and then
  // silently drop every contact at the per-contact check. 03:00 Pacific is
  // outside every window on every day of the week.
  const offHours = new Date(`${TODAY}T11:00:00Z`);   // 03:00/04:00 Pacific
  const outside = await runDispatch(db, { dryRun: true, now: offHours });
  check('run outside every dial window aborts with a reason',
    outside.aborted === true && outside.reason === 'outside_dial_window',
    JSON.stringify(outside));

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
     VALUES ($1::date - 1, 100, 100, 'green')`, [TODAY]);
  await db.query(
    `UPDATE re_daily_release SET throttle_state='green' WHERE release_date = $1::date - 1`, [TODAY]);
  const led = await resolveTarget(db, TODAY);
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
     VALUES ($1::date - 1, 400, 400, 'green', 200, 0.40)`, [TODAY]);
  // 200 escalations with 40% rollover = 80 leaked, far above the 15% red line.
  await db.query(`DELETE FROM re_daily_release WHERE release_date = $1::date`, [TODAY]);
  const ledRed = await resolveTarget(db, TODAY);
  // These two assertions depend on whether rollover is allowed to GOVERN.
  // RE_ROLLOVER_GOVERNS=false is a supported configuration — outreach volume
  // deliberately decoupled from ISA follow-up capacity — so the suite asserts
  // the correct behaviour for the mode it is running in rather than failing.
  // The third assertion holds either way: the reason must always cite a real
  // rollover figure, because turning the brake off must not turn the
  // instrument off.
  if (ROLLOVER_GOVERNS) {
    check('throttle SEES real rollover and goes red',
      ledRed.throttle_state === 'red', `state=${ledRed.throttle_state} reason=${ledRed.throttle_reason}`);
    check('red throttle actually cuts volume',
      Number(ledRed.target_dials) < 400, `target=${ledRed.target_dials}`);
  } else {
    check('rollover does NOT force red when it is report-only',
      ledRed.throttle_state !== 'red', `state=${ledRed.throttle_state}`);
    check('rollover does NOT cut volume when it is report-only',
      Number(ledRed.target_dials) >= 400, `target=${ledRed.target_dials}`);
  }
  check('throttle reason cites rollover, not "insufficient data"',
    /rollover \d/.test(ledRed.throttle_reason || ''), ledRed.throttle_reason);

  // ---- Wave 0 launch guardrails ----------------------------------------
  // Day 4 of the launch plan is 100 dials, one cohort, mid-morning only. These
  // are read from the environment at import time, so the test asserts the SQL
  // and the window gate behave correctly rather than re-importing the module.
  console.log('\n  -- Wave 0 launch guardrails --');

  const { rows: locked } = await db.query(`
    SELECT c.fub_person_id
      FROM re_contact c JOIN re_cohort co ON co.code = c.cohort_code
     WHERE c.status = 'eligible'
       AND (cardinality($1::text[]) = 0 OR c.cohort_code = ANY($1::text[]))`,
    [['hot_engaged']]);
  const lockedIds = locked.map((r) => Number(r.fub_person_id));
  check('cohort lock admits the named cohort',
    lockedIds.includes(101), `ids=${lockedIds}`);
  check('cohort lock excludes every other cohort',
    !lockedIds.includes(102), `102 is dormant_1_3y, ids=${lockedIds}`);

  const { rows: unlocked } = await db.query(`
    SELECT c.fub_person_id
      FROM re_contact c JOIN re_cohort co ON co.code = c.cohort_code
     WHERE c.status = 'eligible'
       AND (cardinality($1::text[]) = 0 OR c.cohort_code = ANY($1::text[]))`,
    [[]]);
  check('empty cohort lock means no restriction',
    unlocked.length >= locked.length && unlocked.length > 0,
    `locked=${locked.length} unlocked=${unlocked.length}`);

  // ---- rollover measurement --------------------------------------------
  // The throttle's capacity signal. The distinction being tested is the one an
  // early draft of the plan got wrong: a conversation deferred to tomorrow is
  // NOT a lost conversation. Reading deferrals as losses put rollover near 40%
  // against a 15% red line, which would have pinned volume at the floor for the
  // life of the program.
  console.log('\n  -- rollover measurement --');

  const noTable = await measureRolloverPct(db);
  check('rollover is null when the ISA contacts table is absent',
    noTable.pct === null, JSON.stringify(noTable));

  // Stand up a stand-in for the isa-call-list service's table. Only the two
  // columns this adapter reads.
  await db.query(`DROP TABLE IF EXISTS contacts`);
  await db.query(
    `CREATE TABLE contacts (id bigserial PRIMARY KEY,
                            bot_call_at timestamptz, completed_at timestamptz)`);

  const tooFew = await measureRolloverPct(db);
  check('rollover is null below the minimum sample',
    tooFew.pct === null && /need 10/.test(tooFew.reason), JSON.stringify(tooFew));

  // 20 escalated 3 days ago: 18 worked, 2 never touched  -> 10%
  // 30 escalated 6 hours ago, none worked yet            -> inside the 48h
  //    grace period, must NOT count as rollover
  await db.query(`
    INSERT INTO contacts (bot_call_at, completed_at)
    SELECT now() - interval '3 days', now() - interval '2 days' FROM generate_series(1,18)`);
  await db.query(`
    INSERT INTO contacts (bot_call_at, completed_at)
    SELECT now() - interval '3 days', NULL FROM generate_series(1,2)`);
  await db.query(`
    INSERT INTO contacts (bot_call_at, completed_at)
    SELECT now() - interval '6 hours', NULL FROM generate_series(1,30)`);

  const roll = await measureRolloverPct(db);
  check('rollover counts only conversations past the 48h grace period',
    roll.escalations === 20, `escalations=${roll.escalations} (30 recent must be excluded)`);
  check('rollover computes 2/20 = 10%',
    Math.abs(roll.pct - 0.10) < 1e-9, `pct=${roll.pct}`);

  // Anything older than the window is out of scope.
  await db.query(`
    INSERT INTO contacts (bot_call_at, completed_at)
    SELECT now() - interval '30 days', NULL FROM generate_series(1,500)`);
  const windowed = await measureRolloverPct(db);
  check('rollover ignores escalations older than the 7-day window',
    windowed.escalations === 20, `escalations=${windowed.escalations}`);

  // The known timestamp bug in isa-call-list: completed_at before bot_call_at.
  // Those rows are worked, and must not read as rollover.
  await db.query(`
    INSERT INTO contacts (bot_call_at, completed_at)
    SELECT now() - interval '3 days', now() - interval '6 days' FROM generate_series(1,5)`);
  const skewed = await measureRolloverPct(db);
  check('rows with completed_at before bot_call_at still count as worked',
    Math.abs(skewed.pct - (2 / 25)) < 1e-9, `pct=${skewed.pct} escalations=${skewed.escalations}`);

  // And it must actually reach the ledger.
  await db.query(
    `INSERT INTO re_daily_release (release_date, target_dials, throttle_state)
     VALUES ($1::date, 100, 'green') ON CONFLICT (release_date) DO NOTHING`, [TODAY]);
  await nightlyRollup(db, { rolloverPct: skewed.pct, now: NOW });
  const { rows: [led2] } = await db.query(
    `SELECT rollover_pct FROM re_daily_release WHERE release_date = $1::date`, [TODAY]);
  check('measured rollover lands in the ledger the throttle reads',
    Math.abs(Number(led2.rollover_pct) - (2 / 25)) < 1e-6, JSON.stringify(led2));

  await db.query(`DROP TABLE IF EXISTS contacts`);

  // ---- outcome reconciler ----------------------------------------------
  // The independent path that does not trust the GHL webhooks. It only ever
  // marks people REACHED, and the case that matters most is the negative one:
  // an OLD conversation must never resolve a NEW push, or someone who spoke to
  // the bot last month silently satisfies today's call and is never actually
  // reached.
  console.log('\n  -- outcome reconciler --');

  const noLink = await resolveLink(db);
  check('reconciler reports honestly when contacts is absent',
    noLink.ok === false, JSON.stringify(noLink));

  const noneApplied = await reconcileOutcomes(db, recordOutcome);
  check('reconciler is a no-op with no contacts table',
    noneApplied.skipped === true && noneApplied.applied === 0, JSON.stringify(noneApplied));

  // Link by FUB id.
  await db.query(`DROP TABLE IF EXISTS contacts`);
  await db.query(
    `CREATE TABLE contacts (id bigserial PRIMARY KEY, fub_person_id bigint,
                            bot_call_at timestamptz, completed_at timestamptz)`);
  const byId = await resolveLink(db);
  check('reconciler finds the FUB id column',
    byId.ok && byId.by === 'fub_id' && byId.column === 'fub_person_id', JSON.stringify(byId));

  await reset(); await seed();
  await db.query(
    `UPDATE re_contact SET status='in_flight', attempt_count=1,
            last_pushed_at = now() - interval '2 hours' WHERE fub_person_id IN (101,102)`);

  // 101 spoke to the bot an hour ago — after we pushed. 102's conversation is
  // from six days ago, before the push, and must be ignored.
  await db.query(
    `INSERT INTO contacts (fub_person_id, bot_call_at) VALUES
       (101, now() - interval '1 hour'),
       (102, now() - interval '6 days')`);

  const dryReconcile = await reconcileOutcomes(db, recordOutcome, { dryRun: true });
  check('dry run matches only the conversation after the push',
    dryReconcile.matched === 1 && dryReconcile.applied === 0, JSON.stringify(dryReconcile));

  const live = await reconcileOutcomes(db, recordOutcome);
  check('reconciler applies exactly one outcome', live.applied === 1, JSON.stringify(live));

  const { rows: [r101] } = await db.query(
    `SELECT status FROM re_contact WHERE fub_person_id=101`);
  const { rows: [r102] } = await db.query(
    `SELECT status FROM re_contact WHERE fub_person_id=102`);
  check('the reached contact left in_flight', r101.status === 'reached', JSON.stringify(r101));
  check('the stale conversation did NOT resolve the other push',
    r102.status === 'in_flight', JSON.stringify(r102));

  // Link by phone, with deliberately mismatched formatting on each side.
  await db.query(`DROP TABLE IF EXISTS contacts`);
  await db.query(
    `CREATE TABLE contacts (id bigserial PRIMARY KEY, phone text,
                            bot_call_at timestamptz, completed_at timestamptz)`);
  const byPhone = await resolveLink(db);
  check('reconciler falls back to the phone column',
    byPhone.ok && byPhone.by === 'phone', JSON.stringify(byPhone));

  await reset(); await seed();
  await db.query(
    `UPDATE re_contact SET status='in_flight', attempt_count=1,
            last_pushed_at = now() - interval '2 hours' WHERE fub_person_id = 101`);
  await db.query(
    `INSERT INTO contacts (phone, bot_call_at) VALUES ('(310) 555-0101', now() - interval '1 hour')`);
  const phoneRun = await reconcileOutcomes(db, recordOutcome);
  check('phone matching survives different formatting on each side',
    phoneRun.applied === 1, `+13105550101 vs "(310) 555-0101" — ${JSON.stringify(phoneRun)}`);

  await db.query(`DROP TABLE IF EXISTS contacts`);
  await reset(); await seed();

  for (const v of ['re_v_timezone_coverage']) {
    try { await db.query(`SELECT * FROM ${v} LIMIT 3`); check(`view ${v} executes`, true); }
    catch (e) { check(`view ${v} executes`, false, e.message); }
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  await db.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
