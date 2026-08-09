/**
 * When the dispatcher runs.
 *
 * This lives in its own module, as data rather than as cron strings buried in
 * server.js, for one reason: the schedule and the dial windows in ladder.js
 * have to agree, and nothing was checking that they did. The afternoon job used
 * to run Monday through Saturday while Saturday's only window is 10:00-13:00,
 * so the Saturday 16:00 run dialed people in no window at all and filed the
 * attempts under 'saturday_am'. The integration suite now walks this table and
 * asserts every slot lands inside a real window, in both DST and standard time.
 *
 * Hours are the CONTACT-facing local hour in the program timezone; node-cron is
 * given the same timezone, so these are the wall-clock times people are called.
 * dow: 0 = Sunday. Sunday never appears — it is a no-dial day.
 */

export const DISPATCH_SLOTS = [
  { name: 'dispatch-morning',   hour: 10, dows: [1, 2, 3, 4, 5, 6], window: 'mid_morning / saturday_am' },
  { name: 'dispatch-afternoon', hour: 16, dows: [1, 2, 3, 4, 5],    window: 'late_afternoon' },
  { name: 'dispatch-evening',   hour: 18, dows: [1, 2, 3, 4, 5],    window: 'evening' },
];

/** The 5-field cron expression for a slot. */
export function cronExpr(slot) {
  return `0 ${slot.hour} * * ${slot.dows.join(',')}`;
}
