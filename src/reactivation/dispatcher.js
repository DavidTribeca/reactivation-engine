/**
 * Dispatcher — the daily engine.
 *
 * Runs on a cron several times a day. Each run:
 *   1. works out today's dial target (throttle)
 *   2. selects who is due, in wave order, highest engagement score first
 *   3. pushes them into SimpleTalk via GHL
 *   4. records the attempt and moves the contact to in_flight
 *
 * The "everyday things keep moving" property comes from two things:
 *   - every contact carries its own next_eligible_at clock, so nothing needs
 *     manual grouping
 *   - the batch query is NOT scoped to one wave, so when Wave 1 runs dry it
 *     automatically backfills from Wave 2 to hit the daily target
 */

import { nextAttempt, isWithinDialWindow, currentWindowLabel, MAX_ATTEMPTS_PER_7_DAYS } from './ladder.js';
import { programDate } from './db.js';
import { evaluate, nextTarget, RAMP } from './throttle.js';
import * as ghl from './adapters/ghl.js';
import * as fub from './adapters/fub.js';

const TZ = process.env.TZ_NAME || 'America/Los_Angeles';

/**
 * Which consent tiers the AI bot is allowed to dial.
 * Start at 'written' only. Widen ONLY after counsel signs off — see plan §3.
 * Comma-separated env var, e.g. "written,ebr_current".
 */
const ALLOWED_CONSENT_TIERS = (process.env.RE_ALLOWED_CONSENT_TIERS || 'written')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Treat an in_flight contact with no outcome after this long as a no-answer. */
const STALE_INFLIGHT_HOURS = Number(process.env.RE_STALE_INFLIGHT_HOURS || 20);

/**
 * How the daily target is spread across dialing windows. Shares are of the
 * DAILY target, not of each other, and they intentionally sum above 1.0 so a
 * quiet morning can still be made up in the afternoon without exceeding the
 * daily cap (which is enforced separately).
 *
 * Mid-morning gets the largest share because it measures best; evening is
 * smallest because it carries the most complaint risk.
 */
export const WINDOW_SHARE = {
  mid_morning:    Number(process.env.RE_SHARE_MORNING   || 0.45),
  late_afternoon: Number(process.env.RE_SHARE_AFTERNOON || 0.75),
  evening:        Number(process.env.RE_SHARE_EVENING   || 1.00),
  saturday_am:    Number(process.env.RE_SHARE_SATURDAY  || 1.00),
};

/**
 * Hard ceiling on contacts awaiting an outcome. 0 = auto (60% of daily target).
 * This is the system's work-in-progress limit: if SimpleTalk slows or outcomes
 * stop arriving, in-flight stays high and the dispatcher stops adding load
 * until it drains. Set explicitly to match SimpleTalk's concurrency.
 */
const MAX_IN_FLIGHT = Number(process.env.RE_MAX_IN_FLIGHT || 0);

/** Hard cap on any single dispatcher run, regardless of other headroom. */
const MAX_PER_RUN = Number(process.env.RE_MAX_PER_RUN || 400);

/**
 * WAVE 0 LAUNCH GUARDRAILS.
 *
 * The launch plan says the first live day is 100 dials, ONE cohort, mid-morning
 * ONLY — a deliberately small blast radius, because integration bugs surface on
 * the first real batch and they should surface against 100 records rather than
 * 750. Until now that constraint lived in a checklist as prose, with nothing in
 * the code enforcing it. A checklist is not a guardrail; the first live dispatch
 * would have selected from all 23,563 people across every cohort and window.
 *
 * Both default to empty, meaning no restriction. Set them for launch, then
 * clear them to open the program up — a variable change in Railway, not a
 * deploy, and reversible in seconds.
 *
 *   RE_ONLY_COHORTS=hot_engaged
 *   RE_ONLY_WINDOWS=mid_morning
 */
const ONLY_COHORTS = (process.env.RE_ONLY_COHORTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ONLY_WINDOWS = (process.env.RE_ONLY_WINDOWS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------

/**
 * Resolve today's dial target, creating the ledger row if needed.
 */
export async function resolveTarget(db, today) {
  const existing = await db.query(
    `SELECT * FROM re_daily_release WHERE release_date = $1`, [today],
  );
  if (existing.rows.length) return existing.rows[0];

  // Look back at the most recent completed day to decide today's number.
  const prev = await db.query(
    `SELECT * FROM re_daily_release
      WHERE release_date < $1
      ORDER BY release_date DESC
      LIMIT 1`, [today],
  );

  let target = Number(process.env.DAILY_CAP || RAMP.floor);
  let state = 'green';
  let reason = 'first run — using DAILY_CAP';

  if (prev.rows.length) {
    const p = prev.rows[0];
    const greenStreak = await countGreenStreak(db, today);
    const baseline = await trailingAnswerRate(db, 28);

    // Trailing 7-day COUNTS — this is the signature evaluate() expects.
    // (An earlier version passed single-day rates here, left over from the
    //  first throttle design. Because evaluate() reads count fields, every
    //  signal silently reported "insufficient data", every day came back
    //  green, and the throttle ramped 25% a day toward the ceiling with no
    //  regard for rollover, answer rate, or opt-outs. The safety mechanism
    //  was effectively switched off. Caught by reading the log line in the
    //  integration test rather than by any assertion — worth an assertion,
    //  which is now below.)
    const { rows: [w] } = await db.query(
      `SELECT
         count(*) FILTER (WHERE outcome IS NOT NULL)::int                  AS resolved7d,
         count(*) FILTER (WHERE outcome IN ('reached','appointment'))::int AS connects7d,
         count(*) FILTER (WHERE outcome = 'opted_out')::int                AS optouts7d
       FROM re_attempt
       WHERE pushed_at > now() - interval '7 days'`);

    // Rollover arrives as a percentage from the ISA-list scheduler, so
    // reconstruct counts from it against that day's reached_count.
    const { rows: [r] } = await db.query(
      `SELECT
         COALESCE(sum(reached_count), 0)::int                              AS escalations7d,
         COALESCE(sum(reached_count * COALESCE(rollover_pct, 0)), 0)::int  AS leaked7d
       FROM re_daily_release
       WHERE release_date > current_date - 7 AND rollover_pct IS NOT NULL`);

    const verdict = evaluate({
      escalations7d: Number(r.escalations7d),
      leaked7d:      Number(r.leaked7d),
      resolved7d:    Number(w.resolved7d),
      connects7d:    Number(w.connects7d),
      optOuts7d:     Number(w.optouts7d),
      baselineAnswerRate: baseline,
      consecutiveGreenDays: greenStreak,
    });

    target = nextTarget(Number(p.target_dials), verdict);
    state = verdict.state;
    reason = verdict.reasons.join('; ') || 'all metrics within target';

    // VOLUME SPIKE GUARD. The throttle can only step up 25% at a time, but a
    // mistyped DAILY_CAP or a hand-edited ledger row could still produce a
    // huge day. Cap at 2x what actually went out yesterday. Anything larger is
    // far more likely to be a mistake than a decision.
    const yesterdayActual = Number(p.actual_pushed || 0);
    if (yesterdayActual > 0) {
      const spikeCeiling = Math.max(RAMP.floor, yesterdayActual * 2);
      if (target > spikeCeiling) {
        reason += `; SPIKE GUARD capped ${target} -> ${spikeCeiling} (2x yesterday's ${yesterdayActual})`;
        target = spikeCeiling;
      }
    }
  }

  // Same guard on the very first run, where DAILY_CAP is taken at face value.
  const hardCeiling = Number(process.env.RE_ABSOLUTE_MAX_PER_DAY || 1000);
  if (target > hardCeiling) {
    reason += `; ABSOLUTE CAP ${target} -> ${hardCeiling}`;
    target = hardCeiling;
  }

  const inserted = await db.query(
    `INSERT INTO re_daily_release (release_date, target_dials, throttle_state, throttle_reason)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (release_date) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [today, target, state, reason],
  );

  console.log(`[dispatch] ${today} target=${target} state=${state} :: ${reason}`);
  return inserted.rows[0];
}

async function countGreenStreak(db, before) {
  const { rows } = await db.query(
    `SELECT throttle_state FROM re_daily_release
      WHERE release_date < $1 ORDER BY release_date DESC LIMIT 14`, [before],
  );
  let n = 0;
  for (const r of rows) {
    if (r.throttle_state === 'green') n++; else break;
  }
  return n;
}

async function trailingAnswerRate(db, days) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE outcome IN ('reached','appointment'))::numeric
            / nullif(count(*), 0) AS rate
       FROM re_attempt
      WHERE pushed_at > now() - ($1 || ' days')::interval
        AND outcome IS NOT NULL`, [days],
  );
  return Number(rows[0]?.rate ?? 0.12);   // 12% seed until real data exists
}

// ---------------------------------------------------------------------------

/**
 * Select and dial. Returns a summary.
 *
 * `now` exists so the time-of-day gates can be driven by an injected clock
 * instead of the wall clock. Nothing in production passes it — the default is
 * the real time — but the integration suite must be able to run at 3am and
 * still exercise the dial path, and a clock read from `new Date()` three
 * separate times inside one run can also straddle a window boundary. One
 * instant, read once, for the whole run.
 */
export async function runDispatch(
  db,
  { dryRun = false, skipFreshnessCheck = false, now = new Date() } = {},
) {
  // The Pacific calendar day — same definition Postgres `current_date` gets on
  // any pool from makePool(). See src/reactivation/db.js for why this is not
  // the UTC date: under UTC days the boundary lands at 17:00 Pacific, which
  // splits every evening dispatch onto the next day's ledger row.
  const today = programDate(now);

  // ---- SAFETY GATE 0: EMERGENCY STOP -------------------------------------
  // One flag halts everything. Checked before any other work so a stop takes
  // effect on the very next run, with no deploy and no Railway access.
  // Note re_dialing_enabled() returns FALSE if the control row is missing —
  // a control table that fails to load must never mean "dial freely".
  if (!dryRun) {
    const { rows: [ctl] } = await db.query(`SELECT re_dialing_enabled() AS ok`);
    if (!ctl?.ok) {
      const { rows: [why] } = await db.query(
        `SELECT note, updated_at, updated_by FROM re_control WHERE key = 'dialing_enabled'`);
      console.error(`[dispatch] STOPPED — dialing is disabled. ` +
        `(${why?.note || 'no note'}; by ${why?.updated_by || '?'} at ${why?.updated_at || '?'})`);
      return { pushed: 0, skipped: 0, aborted: true, reason: 'dialing_disabled' };
    }
  }

  // ---- SAFETY GATE 1: SUPPRESSION FRESHNESS ------------------------------
  // Suppression comes from the FUB "do not contact" pond, and ISAs trash
  // people out of that pond. If the sync has stopped running, our suppression
  // view of the world is stale and we could dial someone who asked not to be
  // called. Refuse to dial rather than risk it.
  if (!dryRun && !skipFreshnessCheck) {
    const { rows: [fresh] } = await db.query(
      `SELECT re_suppression_is_fresh($1) AS ok`,
      [Number(process.env.RE_SUPPRESSION_MAX_AGE_MIN || 120)],
    );
    if (!fresh?.ok) {
      const { rows: [st] } = await db.query(
        `SELECT last_run_at, last_ok_at, detail FROM re_sync_state WHERE key='suppression'`);
      const msg = `[dispatch] ABORT — suppression sync is stale ` +
        `(last ok: ${st?.last_ok_at || 'never'}, detail: ${st?.detail || 'n/a'}). ` +
        `Run scripts/sync-suppression.js before dialing.`;
      console.error(msg);
      return { pushed: 0, skipped: 0, aborted: true, reason: 'stale_suppression_sync' };
    }
  }

  const ledger = await resolveTarget(db, today);

  const pushedToday = Number(
    (await db.query(
      `SELECT count(*)::int AS n FROM re_attempt
        WHERE pushed_at::date = $1 AND push_ok`, [today],
    )).rows[0].n,
  );

  let room = Number(ledger.target_dials) - pushedToday;
  if (room <= 0) {
    console.log(`[dispatch] target met (${pushedToday}/${ledger.target_dials}) — nothing to do`);
    return { pushed: 0, skipped: 0, target: ledger.target_dials, pushedToday };
  }

  // ---- SAFETY GATE 2: ARE WE INSIDE A DIAL WINDOW AT ALL? ----------------
  // The scheduled runs land at 10:00, 16:00 and 18:00, so this only bites on a
  // hand-run. It used to fall back to labelling the run 'mid_morning', which
  // was wrong twice over: it filed attempts under a window they did not happen
  // in (poisoning re_v_window_performance, the view the whole rotating-ladder
  // decision rests on), and it let the run select a batch that the per-contact
  // check below then silently discarded — "selected=2 pushed=0" with no reason
  // given. Refusing outright, with the reason, is the honest behaviour.
  const windowLabel = currentWindowLabel(now, TZ);
  if (windowLabel && ONLY_WINDOWS.length && !ONLY_WINDOWS.includes(windowLabel)) {
    console.log(`[dispatch] window ${windowLabel} is not in RE_ONLY_WINDOWS ` +
      `(${ONLY_WINDOWS.join(',')}) — standing down`);
    return { pushed: 0, skipped: 0, aborted: true, reason: 'window_not_enabled', windowLabel };
  }
  if (!windowLabel) {
    console.error(`[dispatch] ABORT — ${now.toISOString()} is not inside any dial ` +
      `window (${TZ}). Windows: mid_morning, late_afternoon, evening, saturday_am.`);
    return { pushed: 0, skipped: 0, aborted: true, reason: 'outside_dial_window' };
  }

  // ---- FLOW CONTROL: how many are allowed in the system right now --------
  // Three independent ceilings, and the run takes the smallest.
  //
  // 1. WINDOW SHARE — without this the first run of the day pushes the entire
  //    daily target at 10am, which would blow SimpleTalk's concurrency, burn
  //    every caller number's daily cap inside an hour, and dump a whole day of
  //    conversations onto the ISA list at once.
  // 2. IN-FLIGHT CEILING — never have more than N contacts awaiting an outcome.
  //    This is the real "work in progress" limit and it self-regulates: if
  //    SimpleTalk slows down, outcomes stop arriving, in-flight stays high, and
  //    the dispatcher stops adding until the system drains.
  // 3. PER-RUN CAP — a hard upper bound on any single batch.

  const windowShare = WINDOW_SHARE[windowLabel] ?? 1.0;
  const windowAllowance = Math.ceil(Number(ledger.target_dials) * windowShare);
  const windowUsed = Number((await db.query(
    `SELECT count(*)::int AS n FROM re_attempt
      WHERE pushed_at::date = $1 AND window_label = $2 AND push_ok`,
    [today, windowLabel])).rows[0].n);
  const windowRoom = Math.max(0, windowAllowance - windowUsed);

  const inFlight = Number((await db.query(
    `SELECT count(*)::int AS n FROM re_contact WHERE status = 'in_flight'`)).rows[0].n);
  const inFlightCeiling = MAX_IN_FLIGHT || Math.ceil(Number(ledger.target_dials) * 0.6);
  const inFlightRoom = Math.max(0, inFlightCeiling - inFlight);

  room = Math.min(room, windowRoom, inFlightRoom, MAX_PER_RUN);

  console.log(`[dispatch] window=${windowLabel} share=${windowShare} ` +
    `dailyRoom=${Number(ledger.target_dials) - pushedToday} windowRoom=${windowRoom} ` +
    `inFlight=${inFlight}/${inFlightCeiling} -> room=${room}`);

  if (room <= 0) {
    const reason = inFlightRoom <= 0 ? 'in-flight ceiling reached — waiting for outcomes'
      : windowRoom <= 0 ? 'window allowance used'
      : 'no room';
    console.log(`[dispatch] holding: ${reason}`);
    return { pushed: 0, skipped: 0, held: reason, inFlight,
      target: ledger.target_dials, pushedToday };
  }

  // ---- batch selection -------------------------------------------------
  // Not scoped to a wave: this is what makes waves self-refilling.
  // FOR UPDATE SKIP LOCKED makes concurrent dispatcher runs safe.
  const { rows: batch } = await db.query(
    `SELECT c.*, co.wave
       FROM re_contact c
       JOIN re_cohort co ON co.code = c.cohort_code
      WHERE c.status = 'eligible'
        AND c.next_eligible_at <= now()
        AND c.attempt_count < c.max_attempts
        AND c.consent_tier = ANY($1::text[])
        AND co.active
        AND (co.not_before IS NULL OR co.not_before <= current_date)
        AND NOT EXISTS (
          SELECT 1 FROM re_suppression s WHERE s.phone_e164 = c.phone_e164
        )
        AND (
          SELECT count(*) FROM re_attempt a
           WHERE a.contact_id = c.id
             AND a.pushed_at > now() - interval '7 days'
        ) < $2
        -- SAME-DAY GUARD: two dispatcher runs in different windows must never
        -- both pick up the same person. The rolling-7 check allows 3 per week,
        -- which without this would permit two in one day.
        AND NOT EXISTS (
          SELECT 1 FROM re_attempt a2
           WHERE a2.contact_id = c.id AND a2.pushed_at::date = current_date
        )
        -- UNKNOWN-TIMEZONE GUARD: a contact we can't place is restricted to
        -- the mid-morning window, which is inside legal hours everywhere in
        -- the continental US regardless of where they actually are.
        AND (c.tz_source <> 'default_unknown' OR $4 = 'mid_morning')
        -- WAVE 0 COHORT LOCK: empty array means no restriction.
        AND (cardinality($5::text[]) = 0 OR c.cohort_code = ANY($5::text[]))
      ORDER BY co.wave ASC, c.priority_score DESC, c.next_eligible_at ASC
      LIMIT $3
      FOR UPDATE OF c SKIP LOCKED`,
    [ALLOWED_CONSENT_TIERS, MAX_ATTEMPTS_PER_7_DAYS, room, windowLabel, ONLY_COHORTS],
  );

  console.log(`[dispatch] window=${windowLabel} room=${room} selected=${batch.length}` +
    (ONLY_COHORTS.length ? ` [cohort lock: ${ONLY_COHORTS.join(',')}]` : '') +
    (ONLY_WINDOWS.length ? ` [window lock: ${ONLY_WINDOWS.join(',')}]` : ''));

  const callerNumbers = await availableCallerNumbers(db, today);
  let pushed = 0, skipped = 0, ci = 0;

  for (const contact of batch) {
    // Final safety check — a stale queue row must never cause an out-of-hours dial.
    if (!isWithinDialWindow(now, contact.timezone || TZ)) {
      skipped++;
      continue;
    }

    const fromNumber = callerNumbers.length
      ? callerNumbers[ci++ % callerNumbers.length]
      : null;

    if (dryRun) {
      console.log(`[dry-run] would dial ${contact.phone_e164} ` +
        `wave=${contact.wave} cohort=${contact.cohort_code} attempt=${contact.attempt_count + 1}`);
      pushed++;
      continue;
    }

    try {
      const ghlId = await ghl.pushForDial(contact);

      await db.query(
        `INSERT INTO re_attempt
           (contact_id, attempt_number, window_label, from_number, push_ok)
         VALUES ($1, $2, $3, $4, true)`,
        [contact.id, contact.attempt_count + 1, windowLabel, fromNumber],
      );

      await db.query(
        `UPDATE re_contact
            SET status = 'in_flight',
                attempt_count = attempt_count + 1,
                ghl_contact_id = COALESCE($2, ghl_contact_id),
                last_pushed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [contact.id, ghlId],
      );

      // First attempt only: mark the cohort in FUB so the team has context.
      if (contact.attempt_count === 0 && contact.fub_person_id) {
        await fub.tagCohort(contact.fub_person_id, {
          wave: contact.wave, cohortCode: contact.cohort_code,
        }).catch((e) => console.warn(`[fub] tag failed ${contact.fub_person_id}: ${e.message}`));
      }

      pushed++;
    } catch (err) {
      console.error(`[dispatch] push failed for contact ${contact.id}: ${err.message}`);
      await db.query(
        `INSERT INTO re_attempt
           (contact_id, attempt_number, window_label, from_number, push_ok, push_error)
         VALUES ($1, $2, $3, $4, false, $5)`,
        [contact.id, contact.attempt_count + 1, windowLabel, fromNumber, err.message],
      );
      // Leave status 'eligible' and back off 2h so a transient API failure
      // does not consume an attempt.
      await db.query(
        `UPDATE re_contact
            SET next_eligible_at = now() + interval '2 hours', updated_at = now()
          WHERE id = $1`, [contact.id],
      );
      skipped++;
    }
  }

  await db.query(
    `UPDATE re_daily_release
        SET actual_pushed = actual_pushed + $2, updated_at = now()
      WHERE release_date = $1`, [today, pushed],
  );

  console.log(`[dispatch] pushed=${pushed} skipped=${skipped}`);
  return { pushed, skipped, target: ledger.target_dials, pushedToday: pushedToday + pushed };
}

/** Caller IDs still under their daily cap. Keeps any one number off the spam lists. */
async function availableCallerNumbers(db, today) {
  const { rows } = await db.query(
    `SELECT n.phone_e164
       FROM re_caller_number n
       LEFT JOIN (
         SELECT from_number, count(*) AS used
           FROM re_attempt
          WHERE pushed_at::date = $1
          GROUP BY from_number
       ) u ON u.from_number = n.phone_e164
      WHERE n.active
        AND COALESCE(u.used, 0) < n.daily_cap
      ORDER BY COALESCE(u.used, 0) ASC`, [today],
  );
  return rows.map((r) => r.phone_e164);
}

// ---------------------------------------------------------------------------

/**
 * Record an outcome and advance the state machine.
 * Call this from the SimpleTalk ingest and from the GHL webhook.
 *
 * @param {string} outcome  no_answer | voicemail | reached | appointment | opted_out | bad_number
 */
export async function recordOutcome(db, { contactId, outcome, conversationId = null, raw = null }) {
  const { rows } = await db.query(`SELECT * FROM re_contact WHERE id = $1`, [contactId]);
  const contact = rows[0];
  if (!contact) throw new Error(`no re_contact ${contactId}`);

  // Attach to the most recent open attempt.
  await db.query(
    `UPDATE re_attempt
        SET outcome = $2, outcome_at = now(),
            simpletalk_conversation_id = COALESCE($3, simpletalk_conversation_id),
            raw = COALESCE($4, raw)
      WHERE id = (
        SELECT id FROM re_attempt
         WHERE contact_id = $1 AND outcome IS NULL
         ORDER BY pushed_at DESC LIMIT 1
      )`,
    [contactId, outcome, conversationId, raw],
  );

  // --- terminal outcomes: stop the bot immediately ---
  if (['reached', 'appointment', 'opted_out', 'bad_number'].includes(outcome)) {
    const statusMap = {
      reached: 'reached',
      appointment: 'appointment',
      opted_out: 'opted_out',
      bad_number: 'invalid_phone',
    };

    await db.query(
      `UPDATE re_contact
          SET status = $2, last_outcome = $3, last_outcome_at = now(), updated_at = now()
        WHERE id = $1`,
      [contactId, statusMap[outcome], outcome],
    );

    if (['opted_out', 'bad_number'].includes(outcome)) {
      await db.query(
        `INSERT INTO re_suppression (phone_e164, reason, source)
         VALUES ($1, $2, 'reactivation-engine')
         ON CONFLICT (phone_e164) DO NOTHING`,
        [contact.phone_e164, outcome === 'opted_out' ? 'opt_out' : 'bad_number'],
      );
    }

    // Belt and braces: pull from the GHL workflow AND tag FUB.
    if (contact.ghl_contact_id) await ghl.removeFromSimpleTalk(contact.ghl_contact_id);
    if (contact.fub_person_id) {
      await fub.applyStopAiCall(contact.fub_person_id, outcome)
        .catch((e) => console.warn(`[fub] stop tag failed: ${e.message}`));
    }
    return { status: statusMap[outcome] };
  }

  // --- non-terminal: schedule the next rung, or exhaust ---
  const next = nextAttempt(contact.attempt_count, new Date(), contact.timezone || TZ);

  if (!next || contact.attempt_count >= contact.max_attempts) {
    await db.query(
      `UPDATE re_contact
          SET status = 'exhausted', last_outcome = $2, last_outcome_at = now(),
              next_eligible_at = now() + interval '120 days', updated_at = now()
        WHERE id = $1`,
      [contactId, outcome],
    );
    if (contact.ghl_contact_id) await ghl.removeFromSimpleTalk(contact.ghl_contact_id);
    return { status: 'exhausted' };
  }

  await db.query(
    `UPDATE re_contact
        SET status = 'eligible', last_outcome = $2, last_outcome_at = now(),
            next_eligible_at = $3, updated_at = now()
      WHERE id = $1`,
    [contactId, outcome, next.runAt],
  );

  // Remove from the workflow so the next enrolment re-fires cleanly.
  if (contact.ghl_contact_id) await ghl.removeFromSimpleTalk(contact.ghl_contact_id);

  return { status: 'eligible', nextAttempt: next.attempt, nextAt: next.runAt, window: next.window };
}

/**
 * Safety net: contacts stuck in_flight with no outcome. Without this, a missed
 * webhook silently parks someone forever.
 */
export async function reapStaleInFlight(db) {
  const { rows } = await db.query(
    `SELECT id FROM re_contact
      WHERE status = 'in_flight'
        AND last_pushed_at < now() - ($1 || ' hours')::interval`,
    [STALE_INFLIGHT_HOURS],
  );

  for (const { id } of rows) {
    await recordOutcome(db, { contactId: id, outcome: 'no_answer' });
  }

  if (rows.length) console.log(`[reap] ${rows.length} stale in_flight -> no_answer`);
  return rows.length;
}

/**
 * Nightly rollup: writes the metrics the throttle reads tomorrow.
 * `rolloverPct` must come from your existing ISA-list rollover logging —
 * wire it in from the scheduler that already emits
 * "[scheduler] rolled N uncalled contact(s)".
 */
export async function nightlyRollup(db, { rolloverPct = null, now = new Date() } = {}) {
  // Same program-day definition the dispatcher used when it wrote the ledger
  // row this rollup is about to fill in. The rollup runs at 21:30 Pacific,
  // which under UTC days was already tomorrow.
  const today = programDate(now);

  await db.query(
    `WITH d AS (
       SELECT
         count(*) FILTER (WHERE outcome IS NOT NULL)                     AS resolved,
         count(*) FILTER (WHERE outcome IN ('reached','appointment'))     AS reached,
         count(*) FILTER (WHERE outcome = 'appointment')                  AS appts,
         count(*) FILTER (WHERE outcome = 'opted_out')                    AS optouts
       FROM re_attempt
       WHERE pushed_at::date = $1
     )
     UPDATE re_daily_release r
        SET answer_rate  = CASE WHEN d.resolved > 0 THEN d.reached::numeric / d.resolved END,
            optout_rate  = CASE WHEN d.reached  > 0 THEN d.optouts::numeric / d.reached  END,
            reached_count = d.reached,
            appointment_count = d.appts,
            rollover_pct = COALESCE($2, r.rollover_pct),
            updated_at = now()
       FROM d
      WHERE r.release_date = $1`,
    [today, rolloverPct],
  );

  console.log(`[rollup] ${today} written`);
}
