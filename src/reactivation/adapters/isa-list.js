/**
 * ISA-list adapter — reads the human side of the funnel.
 *
 * The `contacts` table belongs to the existing isa-call-list service, which
 * shares this Postgres. It holds one row per conversation the bot escalated to
 * a human: `bot_call_at` when the bot handed it over, `completed_at` when an
 * ISA actually worked it (written only when a real call is logged in Follow Up
 * Boss, not on a manual dismissal).
 *
 * WHY THIS EXISTS
 *
 * The throttle's most important input is rollover — the share of escalated
 * conversations that no human gets to. Volume is only safe to increase while
 * the humans downstream can absorb it; everything else the throttle watches
 * (answer rate, opt-out rate) is about the bot, not about capacity. Until now
 * `nightlyRollup` was called with `rolloverPct: null`, so the throttle ran on
 * two signals out of three and could ramp straight past the point where
 * conversations start dying in the queue.
 *
 * WHAT COUNTS AS ROLLOVER — this is the part that was got wrong once already
 *
 * The obvious source is the scheduler's `[scheduler] rolled N uncalled
 * contact(s)` log line, and an early draft of the plan read those as lost
 * conversations. They are not. They record a contact being DEFERRED to the next
 * day, and the direct query on 6 August showed 125 of 130 conversations (96%)
 * were eventually worked, at a median of 6.1 hours. Feeding deferrals to the
 * throttle as though they were losses would have read ~40% rollover against a
 * 15% red line and pinned volume at the floor forever.
 *
 * So rollover here means: escalated long enough ago to have been actionable,
 * and still not worked. The grace period is 48 hours, matching the ISA SLA of
 * three attempts within 48 hours — inside that window a conversation is in
 * progress, outside it is dropped.
 *
 * Deliberately reads only `bot_call_at` and `completed_at`, the two columns
 * confirmed against the live table. Note some rows carry a `completed_at`
 * EARLIER than their `bot_call_at` (a known timestamp bug in that service, min
 * -65 hours). This only tests whether `completed_at` is null, never the
 * ordering, so that bug cannot skew the number.
 */

const GRACE_HOURS = Number(process.env.RE_ROLLOVER_GRACE_HOURS || 48);
const WINDOW_DAYS = Number(process.env.RE_ROLLOVER_WINDOW_DAYS || 7);

/** Minimum escalations before the number means anything. */
export const MIN_ESCALATIONS = 10;

/**
 * Measure rollover over the trailing window.
 *
 * Returns { pct, escalations, leaked, reason } — `pct` is a fraction (0.15 =
 * 15%) or null. Null every time it cannot answer honestly: table absent, too
 * few escalations, or a query error. Null is the safe value: nightlyRollup
 * leaves the previous rollover_pct untouched and the throttle reports
 * "insufficient data" for that signal rather than acting on a wrong one.
 */
export async function measureRolloverPct(db, {
  graceHours = GRACE_HOURS,
  windowDays = WINDOW_DAYS,
} = {}) {
  const { rows: [t] } = await db.query(
    `SELECT to_regclass('public.contacts') IS NOT NULL AS present`);
  if (!t?.present) {
    return { pct: null, escalations: 0, leaked: 0, reason: 'contacts table not present' };
  }

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT
         count(*)::int                                       AS escalations,
         count(*) FILTER (WHERE completed_at IS NULL)::int    AS leaked
       FROM contacts
       WHERE bot_call_at > now() - ($1 || ' days')::interval
         AND bot_call_at < now() - ($2 || ' hours')::interval`,
      [windowDays, graceHours],
    ));
  } catch (err) {
    // Wrong column names, permissions, anything — say so, do not guess.
    console.error(`[isa-list] rollover query failed: ${err.message}`);
    return { pct: null, escalations: 0, leaked: 0, reason: `query failed: ${err.message}` };
  }

  const escalations = Number(rows[0].escalations);
  const leaked = Number(rows[0].leaked);

  if (escalations < MIN_ESCALATIONS) {
    return {
      pct: null, escalations, leaked,
      reason: `only ${escalations} escalations older than ${graceHours}h ` +
              `(need ${MIN_ESCALATIONS})`,
    };
  }

  const pct = leaked / escalations;
  return {
    pct, escalations, leaked,
    reason: `${leaked}/${escalations} unworked after ${graceHours}h over ${windowDays}d`,
  };
}
