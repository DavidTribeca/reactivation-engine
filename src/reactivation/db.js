/**
 * Database pool and the definition of a "program day".
 *
 * WHY THIS FILE EXISTS
 *
 * Everything about this system is scheduled in Pacific time: the cron runs at
 * 10:00, 16:00 and 18:00 Pacific, the dial windows are Pacific, the 8am-8pm
 * legal bound is Pacific. But "today" was being computed two different ways —
 * JavaScript took the UTC date, and Postgres `current_date` took the server's
 * date, which on Railway is also UTC.
 *
 * Under UTC days, the boundary falls at 17:00 Pacific (16:00 in winter). The
 * evening dispatch runs at 18:00 Pacific, which is AFTER that boundary, so its
 * dials were filed against the NEXT day's ledger row. Consequences, all quiet:
 *
 *   · the daily target was split across two ledger rows every single day, so
 *     `actual_pushed` never matched what actually went out on that day
 *   · the next morning's run opened with the previous evening's dials already
 *     counted against it, and cut its own batch to compensate
 *   · the throttle reads `actual_pushed` to decide whether to ramp; the volume
 *     spike guard caps at 2x yesterday's actual. Both were reading a number
 *     that was missing an evening and carrying someone else's
 *
 * The fix is to make one timezone authoritative on both sides. `makePool` sets
 * the session timezone on every connection it hands out, so Postgres
 * `current_date` and `programDate()` below agree, and both mean "the Pacific
 * calendar day", which is the day the schedule and the law are written in.
 *
 * This is set per-connection, not on the database, so the isa-call-list service
 * sharing this Postgres is unaffected.
 */

import pg from 'pg';
import { localParts } from './ladder.js';

export const TZ = process.env.TZ_NAME || 'America/Los_Angeles';

/**
 * A pool whose sessions agree with programDate() about what day it is.
 *
 * The timezone goes in the libpq `options` string rather than a `SET TIME ZONE`
 * on the pool's connect event. Postgres applies it as part of establishing the
 * session, so there is no window in which a query could run against a
 * still-UTC session, and no extra round trip per connection.
 */
export function makePool(opts = {}) {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c timezone=${TZ}`,
    ...opts,
  });
}

/**
 * The program day containing `instant`, as YYYY-MM-DD in Pacific time.
 * Matches Postgres `current_date` on any pool from makePool().
 */
export function programDate(instant = new Date(), timeZone = TZ) {
  const { year, month, day } = localParts(instant, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
