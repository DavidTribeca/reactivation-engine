/**
 * Health check — the thing that makes "unattended" actually true.
 *
 *   node scripts/health-check.js
 *
 * Cron:  0 8,13,20 * * *   (three times a day, America/Los_Angeles)
 *
 * WHY THIS EXISTS
 * Every safety mechanism in this engine fails CLOSED: a stale suppression sync
 * halts dialing, an in-flight ceiling pauses intake, a red throttle halves
 * volume. That is the correct behaviour — but it means the program can quietly
 * stop and nobody finds out until someone thinks to look. A system that stops
 * safely but silently is not unattended; it is just broken slowly.
 *
 * This check runs a few times a day, decides whether a human is needed, and
 * pushes to RE_ALERT_WEBHOOK (Slack, Discord, Zapier, or a GHL inbound hook —
 * any endpoint that accepts a JSON POST). It exits non-zero on CRITICAL so
 * Railway's own cron failure alerting fires too, giving you two independent
 * ways to hear about it.
 *
 * Env:
 *   RE_ALERT_WEBHOOK      JSON POST target. Unset = log only.
 *   RE_ALERT_ON_WARNING   "true" to page on warnings as well as criticals.
 */

import { makePool, programDate } from '../src/reactivation/db.js';
import { measureRolloverPct } from '../src/reactivation/adapters/isa-list.js';
const WEBHOOK = process.env.RE_ALERT_WEBHOOK || null;
const ALERT_ON_WARNING = process.env.RE_ALERT_ON_WARNING === 'true';
const TZ = process.env.TZ_NAME || 'America/Los_Angeles';

const findings = [];
const add = (level, code, message, detail) =>
  findings.push({ level, code, message, detail });

function localHour() {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', hour12: false,
  }).format(new Date()).replace('24', '00'));
}

function localDow() {
  const d = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(new Date());
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[d];
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const db = makePool({ max: 3 });

  // Program day, not the UTC day — see src/reactivation/db.js.
  const today = programDate();
  const hour = localHour();
  const dow = localDow();
  const isDialingDay = dow !== 0;
  // Only judge "did we dial today" after the first window has closed.
  const pastFirstWindow = hour >= 13;

  // ---- 1. suppression freshness — dialing is HALTED if stale --------------
  const { rows: [sup] } = await db.query(
    `SELECT re_suppression_is_fresh($1) AS fresh, s.last_ok_at, s.last_run_at, s.detail
       FROM re_sync_state s WHERE s.key = 'suppression'`,
    [Number(process.env.RE_SUPPRESSION_MAX_AGE_MIN || 120)]);

  if (!sup || !sup.fresh) {
    add('CRITICAL', 'suppression_stale',
      'Suppression sync is stale — the dispatcher is refusing to dial. The program is STOPPED.',
      { last_ok_at: sup?.last_ok_at || 'never', detail: sup?.detail || 'n/a' });
  }

  // ---- 2. did the dispatcher actually run? --------------------------------
  const { rows: [pushed] } = await db.query(
    `SELECT count(*)::int AS n FROM re_attempt WHERE pushed_at::date = $1 AND push_ok`, [today]);
  const { rows: [ledger] } = await db.query(
    `SELECT target_dials, actual_pushed, throttle_state, throttle_reason
       FROM re_daily_release WHERE release_date = $1`, [today]);

  if (isDialingDay && pastFirstWindow && pushed.n === 0) {
    const remaining = await db.query(
      `SELECT count(*)::int AS n FROM re_contact WHERE status = 'eligible'`);
    if (Number(remaining.rows[0].n) > 0) {
      add('CRITICAL', 'no_dials_today',
        'No dials pushed today despite a non-empty queue. The dispatcher is not running or is blocked.',
        { eligible_remaining: remaining.rows[0].n, throttle: ledger?.throttle_reason });
    } else {
      add('INFO', 'queue_empty', 'No dials because the queue is empty — the program may be complete.', {});
    }
  }

  // ---- 3. push failure rate — is the GHL integration broken? --------------
  const { rows: [pf] } = await db.query(
    `SELECT count(*) FILTER (WHERE NOT push_ok)::int AS failed,
            count(*)::int AS total
       FROM re_attempt WHERE pushed_at > now() - interval '24 hours'`);
  if (pf.total >= 20 && pf.failed / pf.total > 0.2) {
    add('CRITICAL', 'push_failures',
      `${pf.failed} of ${pf.total} pushes failed in 24h — the GHL integration is likely broken.`,
      { failed: pf.failed, total: pf.total });
  } else if (pf.total >= 20 && pf.failed / pf.total > 0.05) {
    add('WARNING', 'push_failures_elevated',
      `${pf.failed} of ${pf.total} pushes failed in 24h.`, { failed: pf.failed, total: pf.total });
  }

  // ---- 4. outcomes coming back? -------------------------------------------
  // If in-flight is high and nothing has resolved, the outcome feed is dead —
  // which means the bot keeps calling people who already answered.
  const { rows: [flight] } = await db.query(
    `SELECT (SELECT count(*)::int FROM re_contact WHERE status = 'in_flight') AS in_flight,
            (SELECT count(*)::int FROM re_attempt
              WHERE outcome_at > now() - interval '24 hours') AS resolved_24h`);
  if (flight.in_flight > 50 && flight.resolved_24h === 0) {
    add('CRITICAL', 'outcome_feed_dead',
      `${flight.in_flight} contacts in flight but zero outcomes recorded in 24h — the outcome feed is down. ` +
      `The bot may be re-calling people who already answered.`,
      { in_flight: flight.in_flight });
  }

  // ---- 5. throttle stuck red ----------------------------------------------
  const { rows: red } = await db.query(
    `SELECT release_date, throttle_state, throttle_reason
       FROM re_daily_release ORDER BY release_date DESC LIMIT 3`);
  if (red.length === 3 && red.every((r) => r.throttle_state === 'red')) {
    add('WARNING', 'throttle_red_3d',
      'Throttle has been red for 3 consecutive days — volume is being cut repeatedly.',
      { reasons: red.map((r) => r.throttle_reason) });
  }

  // ---- 6. caller-ID reputation --------------------------------------------
  const { rows: numbers } = await db.query(
    `SELECT count(*) FILTER (WHERE active)::int AS active_numbers FROM re_caller_number`);
  if (Number(numbers[0].active_numbers) === 0) {
    add('CRITICAL', 'no_caller_numbers', 'No active caller numbers configured.', {});
  } else if (Number(numbers[0].active_numbers) < 4 && Number(ledger?.target_dials || 0) > 400) {
    add('WARNING', 'too_few_numbers',
      `Only ${numbers[0].active_numbers} active numbers for a ${ledger.target_dials}/day target — ` +
      `each will exceed safe volume and get flagged.`, {});
  }

  try {
    const { rows: retire } = await db.query(
      `SELECT from_number, answer_rate_pct FROM re_v_number_health WHERE recommendation = 'RETIRE'`);
    if (retire.length) {
      add('WARNING', 'retire_numbers',
        `${retire.length} caller number(s) are answering well below the pool median — likely flagged as spam.`,
        { numbers: retire.map((r) => r.from_number) });
    }
  } catch { /* view needs data; ignore when empty */ }

  // ---- 7. opt-out spike ----------------------------------------------------
  const { rows: [oo] } = await db.query(
    `SELECT count(*) FILTER (WHERE outcome = 'opted_out')::int AS optouts,
            count(*) FILTER (WHERE outcome IN ('reached','appointment','opted_out'))::int AS connects
       FROM re_attempt WHERE outcome_at > now() - interval '7 days'`);
  if (oo.connects >= 50 && oo.optouts / oo.connects > 0.02) {
    add('WARNING', 'optout_spike',
      `Opt-out rate ${(100 * oo.optouts / oo.connects).toFixed(1)}% over 7 days — review script and targeting.`,
      { optouts: oo.optouts, connects: oo.connects });
  }

  // ---- 8. ISA follow-up backlog — the human side of the funnel ------------
  //
  // This is the check whose absence hurt. Checks 1-7 all watch the BOT: is it
  // dialing, are pushes landing, are outcomes coming back, is the caller ID
  // burning. None of them watch what happens after the bot succeeds.
  //
  // The most expensive failure in this program is a conversation the bot won
  // and nobody called back — worse for the brand than never calling at all,
  // and invisible to every other check here. On 26 Aug 2026 the ISA queue held
  // 42 people with no logged call, the oldest waiting since 30 July, while
  // rollover sat near 78% for a week. Nothing paged anyone, because nothing
  // was looking.
  //
  // It is also the one failure the engine cannot fix by itself. Volume can be
  // throttled down to limit the damage, but only a person can return a call.
  // So this one pages.
  try {
    const roll = await measureRolloverPct(db);

    if (roll.pct !== null && roll.pct >= 0.15) {
      let waiting = null;
      let oldestDays = null;
      try {
        const { rows: [q] } = await db.query(
          `SELECT count(*)::int                                        AS waiting,
                  max(floor(extract(epoch FROM now() - bot_call_at) / 86400))::int AS oldest_days
             FROM contacts
            WHERE completed_at IS NULL AND bot_call_at IS NOT NULL`);
        waiting = q.waiting;
        oldestDays = q.oldest_days;
      } catch { /* other service's table; the percentage alone still pages */ }

      add('CRITICAL', 'isa_backlog',
        `${(roll.pct * 100).toFixed(0)}% of bot conversations went unworked (${roll.reason}).` +
        (waiting !== null
          ? ` ${waiting} still waiting, oldest for ${oldestDays} day(s).`
          : '') +
        ' Every one is someone who agreed to a call and never got one.' +
        ' Volume is being throttled, but only a person can clear this.',
        { rollover_pct: Number(roll.pct.toFixed(3)), escalations: roll.escalations,
          leaked: roll.leaked, waiting, oldest_days: oldestDays });

    } else if (roll.pct !== null && roll.pct > 0.05) {
      add('WARNING', 'isa_backlog_rising',
        `Rollover ${(roll.pct * 100).toFixed(0)}% — above the 5% target and heading for the ` +
        `15% line where volume gets cut (${roll.reason}).`,
        { rollover_pct: Number(roll.pct.toFixed(3)) });

    } else if (roll.pct === null) {
      add('INFO', 'rollover_unmeasurable',
        `Rollover could not be measured: ${roll.reason}`, {});
    }
  } catch (e) {
    add('WARNING', 'rollover_check_failed',
      `The ISA backlog check itself failed: ${e.message}`, {});
  }
  // ----verdict  -------------------------------------------------------------
  const critical = findings.filter((f) => f.level === 'CRITICAL');
  const warnings = findings.filter((f) => f.level === 'WARNING');
  const status = critical.length ? 'CRITICAL' : warnings.length ? 'WARNING' : 'OK';

  const { rows: [flow] } = await db.query(`SELECT * FROM re_v_flow`);

  const report = {
    status,
    checked_at: new Date().toISOString(),
    summary: status === 'OK'
      ? `Healthy. ${pushed.n} dials today, ${flow.in_flight_now} in flight, ${flow.due_now} due now.`
      : `${critical.length} critical, ${warnings.length} warning.`,
    findings,
    snapshot: {
      pushed_today: pushed.n,
      target_today: ledger?.target_dials ?? null,
      throttle_state: ledger?.throttle_state ?? null,
      in_flight: flow.in_flight_now,
      due_now: flow.due_now,
      remaining_eligible: flow.scheduled_later + flow.due_now,
      reached_total: flow.reached_total,
      appointments_total: flow.appointments_total,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  const shouldAlert = critical.length > 0 || (ALERT_ON_WARNING && warnings.length > 0);
  if (shouldAlert && WEBHOOK) {
    const lines = findings
      .filter((f) => f.level !== 'INFO')
      .map((f) => `${f.level === 'CRITICAL' ? '🔴' : '🟡'} ${f.message}`);
    const text = `*Reactivation engine — ${status}*\n${lines.join('\n')}\n\n` +
      `Today: ${report.snapshot.pushed_today}/${report.snapshot.target_today ?? '?'} dials · ` +
      `${report.snapshot.in_flight} in flight · ${report.snapshot.remaining_eligible} remaining`;
    try {
      const res = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, status, findings, snapshot: report.snapshot }),
      });
      console.log(`[alert] webhook ${res.status}`);
    } catch (e) {
      console.error(`[alert] webhook failed: ${e.message}`);
    }
  } else if (shouldAlert) {
    console.error('[alert] RE_ALERT_WEBHOOK not set — alert not delivered anywhere.');
  }

  await db.end();
  // Non-zero exit so Railway's cron failure alerting fires independently.
  process.exit(critical.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
