/**
 * Outcome reconciler — the safety net under the GHL webhooks.
 *
 * WHY THIS EXISTS
 *
 * Outcomes currently arrive one way: a GHL webhook hits /webhooks/ghl and
 * webhook.js maps the payload onto our vocabulary. That mapping is a set of
 * regexes written against event names nobody has ever seen — the comment above
 * mapOutcome says so plainly. If the real event names differ, every webhook
 * lands as 'unknown' and no contact ever leaves in_flight on a real outcome.
 *
 * The failure is quiet and it is the bad kind. A contact the bot actually spoke
 * to stays in_flight, gets reaped after 20 hours as a no-answer, goes back on
 * the ladder, and gets called again. Someone who had a real conversation
 * yesterday gets dialled tomorrow. That is the single worst thing this system
 * can do to a person, and a wrong regex is enough to cause it.
 *
 * So: a second, independent path that does not depend on any webhook. The
 * isa-call-list service already ingests SimpleTalk conversations on a schedule
 * — proven, running daily, writing into `contacts` in this same database. Every
 * row there is a conversation that actually happened. If a contact we pushed
 * turns up in that table, they were reached, whatever the webhook did or did
 * not say.
 *
 * This only ever marks people as REACHED. It never invents a no-answer, an
 * opt-out or a bad number — absence of evidence is not evidence, and the reaper
 * already handles silence. It is a floor under the outcome feed, not a
 * replacement for it.
 *
 * ── ON THE SCHEMA ─────────────────────────────────────────────────────────
 *
 * `contacts` belongs to another service and this session could not read that
 * repo. Two columns are confirmed against the live table (`bot_call_at`,
 * `completed_at`); the column linking a row back to Follow Up Boss is not. So
 * rather than guess in a way that fails silently, this resolves the link column
 * at runtime from a candidate list and reports exactly what it found. If it
 * cannot resolve one it does nothing and says so — `scripts/preflight.js`
 * surfaces that as a named, fixable item instead of a mystery.
 */

/** Candidate names for the Follow Up Boss person id, best guess first. */
const FUB_ID_COLUMNS = [
  'fub_person_id', 'fub_id', 'fub_contact_id', 'followupboss_id',
  'follow_up_boss_record_id', 'fub_record_id', 'person_id',
];

/** Candidate names for the phone number, used when no FUB id column exists. */
const PHONE_COLUMNS = [
  'phone_e164', 'phone', 'phone_number', 'primary_phone', 'mobile_phone', 'cell',
];

/** How far back to look. A conversation older than this is already handled. */
const LOOKBACK_HOURS = Number(process.env.RE_RECONCILE_LOOKBACK_HOURS || 72);

/**
 * Work out how to join `contacts` to `re_contact`.
 * Returns { ok, by, column, available } — `by` is 'fub_id' or 'phone'.
 */
export async function resolveLink(db) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'contacts'`);

  if (!rows.length) {
    return { ok: false, reason: 'contacts table not present', available: [] };
  }

  const available = rows.map((r) => r.column_name);
  const has = (c) => available.includes(c);

  for (const c of FUB_ID_COLUMNS) {
    if (has(c)) return { ok: true, by: 'fub_id', column: c, available };
  }
  for (const c of PHONE_COLUMNS) {
    if (has(c)) return { ok: true, by: 'phone', column: c, available };
  }

  return {
    ok: false,
    reason: 'no usable link column found on contacts',
    available,
  };
}

/**
 * Mark as reached anyone we pushed who subsequently appears in the ISA queue.
 *
 * `apply` is a callback (usually recordOutcome) so this module stays free of a
 * circular import with dispatcher.js, and so a dry run can pass a no-op.
 */
export async function reconcileOutcomes(db, apply, { dryRun = false } = {}) {
  const link = await resolveLink(db);
  if (!link.ok) {
    console.warn(`[reconcile] skipped — ${link.reason}` +
      (link.available.length ? `. Columns on contacts: ${link.available.join(', ')}` : ''));
    return { skipped: true, reason: link.reason, matched: 0, applied: 0, link };
  }

  // Phone matching compares the LAST TEN DIGITS of each side.
  //
  // Stripping punctuation alone is not enough, and the difference is easy to
  // miss: our side stores E.164 (+13105550101 -> 11 digits) while the other
  // service stores whatever SimpleTalk gave it ((310) 555-0101 -> 10 digits).
  // Those two strings of digits are not equal, so a naive comparison matches
  // nothing at all — and this reconciler failing to match is precisely how
  // someone who already spoke to the bot gets called a second time. Ten digits
  // is the North American number; both sides agree on those.
  //
  // Caveat worth knowing: this makes the match country-blind, so a hypothetical
  // +44 number sharing its last ten digits with a US one would collide. Every
  // number in this database is North American, and the cost of a rare false
  // match here is one skipped call, versus a repeat call for a missed one.
  const joinClause = link.by === 'fub_id'
    ? `ct.${link.column}::text = rc.fub_person_id::text`
    : `right(regexp_replace(ct.${link.column}::text, '[^0-9]', '', 'g'), 10) =
       right(regexp_replace(rc.phone_e164,          '[^0-9]', '', 'g'), 10)
       AND length(regexp_replace(rc.phone_e164, '[^0-9]', '', 'g')) >= 10`;

  const { rows: matches } = await db.query(
    `SELECT DISTINCT rc.id, rc.phone_e164, ct.bot_call_at
       FROM re_contact rc
       JOIN contacts ct ON ${joinClause}
      WHERE rc.status = 'in_flight'
        AND ct.bot_call_at IS NOT NULL
        AND ct.bot_call_at > now() - ($1 || ' hours')::interval
        -- Only conversations that happened AFTER we pushed. Without this, a
        -- conversation from last month would resolve today's push.
        AND ct.bot_call_at >= rc.last_pushed_at
      ORDER BY rc.id`,
    [LOOKBACK_HOURS],
  );

  if (!matches.length) {
    console.log(`[reconcile] nothing to reconcile (matching by ${link.by} on ` +
      `contacts.${link.column})`);
    return { skipped: false, matched: 0, applied: 0, link };
  }

  if (dryRun) {
    console.log(`[reconcile] DRY RUN — would mark ${matches.length} contact(s) reached ` +
      `via ${link.by} on contacts.${link.column}`);
    for (const m of matches) console.log(`  would reach ${m.phone_e164}`);
    return { skipped: false, matched: matches.length, applied: 0, link };
  }

  let applied = 0;
  for (const m of matches) {
    try {
      await apply(db, { contactId: m.id, outcome: 'reached' });
      applied++;
    } catch (err) {
      console.error(`[reconcile] failed on contact ${m.id}: ${err.message}`);
    }
  }

  console.log(`[reconcile] ${applied}/${matches.length} marked reached from the ` +
    `SimpleTalk ingest (link: ${link.by} on contacts.${link.column})`);
  return { skipped: false, matched: matches.length, applied, link };
}
