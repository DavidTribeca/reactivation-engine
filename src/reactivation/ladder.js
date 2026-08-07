/**
 * Attempt ladder — decides WHEN the next dial attempt happens.
 *
 * Why this exists: SimpleTalk's native retry calls back at roughly the same
 * time next day, which hits the same reason the person missed the first call.
 * Rotating the window across attempts lifts cumulative 5-attempt reach from
 * ~32% to ~44% on identical dial spend.
 *
 * Pure functions, no I/O — unit-testable and used by the simulation harness.
 */

/** Window definitions in the CONTACT's local time. */
export const WINDOWS = {
  mid_morning:     { startHour: 10, endHour: 12 },
  late_afternoon:  { startHour: 16, endHour: 18 },
  evening:         { startHour: 18, endHour: 20 },   // hard 8pm cutoff
  saturday_am:     { startHour: 10, endHour: 13 },
};

/**
 * The ladder. Index = the attempt about to be made (1-based).
 * dayOffset is counted from attempt 1's date.
 */
export const LADDER = [
  { attempt: 1, dayOffset: 0,  window: 'mid_morning'    },
  { attempt: 2, dayOffset: 1,  window: 'late_afternoon' },
  { attempt: 3, dayOffset: 3,  window: 'evening'        },
  { attempt: 4, dayOffset: 7,  window: 'saturday_am', snapToDow: 6 }, // 6 = Saturday
  { attempt: 5, dayOffset: 14, window: 'mid_morning'    },
];

export const MAX_ATTEMPTS = LADDER.length;

/** Never dial: Sunday. Several states restrict it and complaint risk is higher. */
const BLOCKED_DOW = new Set([0]);

/** Rolling-window guardrail: no more than N attempts per person per 7 days. */
export const MAX_ATTEMPTS_PER_7_DAYS = 3;

// ---------------------------------------------------------------------------
// Timezone helpers (no external deps — uses Intl)
// ---------------------------------------------------------------------------

/**
 * Returns the offset in minutes between UTC and `timeZone` at instant `date`.
 * Positive means the zone is behind UTC (e.g. America/Los_Angeles => 420 or 480).
 */
function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // Intl renders midnight as hour "24" in some engines; normalise.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second),
  );
  return (date.getTime() - asUTC) / 60000;
}

/**
 * Builds the UTC Date for a given local wall-clock time in `timeZone`.
 * Two-pass to settle DST boundaries.
 */
export function localWallTimeToUtc({ year, month, day, hour, minute = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = tzOffsetMinutes(new Date(naive), timeZone);
  let result = new Date(naive + offset * 60000);
  // Re-resolve once: the offset may differ at the corrected instant (DST edge).
  const offset2 = tzOffsetMinutes(result, timeZone);
  if (offset2 !== offset) result = new Date(naive + offset2 * 60000);
  return result;
}

/** Local calendar parts (y/m/d/dow) for an instant in a timezone. */
export function localParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', weekday: 'short',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour === '24' ? 0 : Number(parts.hour),
    dow: dowMap[parts.weekday],
  };
}

// ---------------------------------------------------------------------------
// Ladder logic
// ---------------------------------------------------------------------------

/**
 * Given a contact who has just completed `attemptsMade` attempts, return the
 * schedule for the next one, or null if the ladder is exhausted.
 *
 * @param {number} attemptsMade   attempts already completed (0 = never dialed)
 * @param {Date}   from           instant to schedule relative to (usually now)
 * @param {string} timeZone       contact's IANA timezone
 * @returns {{attempt:number, window:string, runAt:Date}|null}
 */
export function nextAttempt(attemptsMade, from, timeZone = 'America/Los_Angeles') {
  const step = LADDER[attemptsMade]; // 0 attempts made => LADDER[0] => attempt 1
  if (!step) return null;

  const base = localParts(from, timeZone);
  let target = new Date(Date.UTC(base.year, base.month - 1, base.day));
  target.setUTCDate(target.getUTCDate() + step.dayOffset);

  // Snap forward to a specific day of week if the step requires it (Saturday).
  if (step.snapToDow !== undefined) {
    while (target.getUTCDay() !== step.snapToDow) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
  }

  // Never land on a blocked day — roll forward.
  while (BLOCKED_DOW.has(target.getUTCDay())) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  const win = WINDOWS[step.window];
  const runAt = localWallTimeToUtc({
    year:  target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day:   target.getUTCDate(),
    hour:  win.startHour,
  }, timeZone);

  return { attempt: step.attempt, window: step.window, runAt };
}

/**
 * Is `instant` inside a legal dialing window for this contact?
 * Belt-and-braces check applied at push time so a stale queue row can never
 * cause an 11pm dial.
 */
export function isWithinDialWindow(instant, timeZone = 'America/Los_Angeles') {
  const { hour, dow } = localParts(instant, timeZone);
  if (BLOCKED_DOW.has(dow)) return false;
  return hour >= 8 && hour < 20;   // 8am–8pm local, hard bounds
}

/** Which window label does this instant fall into (for dispatcher run tagging)? */
export function currentWindowLabel(instant, timeZone = 'America/Los_Angeles') {
  const { hour, dow } = localParts(instant, timeZone);
  if (dow === 6) return 'saturday_am';
  for (const [label, w] of Object.entries(WINDOWS)) {
    if (label === 'saturday_am') continue;
    if (hour >= w.startHour && hour < w.endHour) return label;
  }
  return null;
}
