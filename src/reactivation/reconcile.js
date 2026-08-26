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
 * Its floor is REACHED. Where the ingest carries its own outcome label it is
 * also allowed to move UP from there — to an appointment, an opt-out or a bad
 * number — because an appointment recorded as a plain 'reached' is a booking
 * that never shows up in your numbers. It still never invents a no-answer or a
 * voicemail: absence of evidence is not evidence, and the reaper already owns
 * silence. It is a floor under the outcome feed, not a replacement for it.
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
  'phone_e164', 'phone_normalized', 'phone', 'phone_number', 'primary_phone',
  'mobile_phone', 'cell',
];

/** How far back to look. A conversation older than this is already handled. */
const LOOKBACK_HOURS = Number(process.env.RE_RECONCILE_LOOKBACK_HOURS || 72);

/** Candidate names for the ingest's own outcome label, best guess first. */
const OUTCOME_COLUMNS = ['bot_call_outcome', 'call_outcome', 'outcome', 'disposition'];

/**
 * Map the ISA ingest's own outcome label onto our vocabulary.
 *
 * The floor is 'reached': if a row carries a bot_call_at then a conversation
 * happened, and that alone is enough to take the contact off the ladder. We
 * only ever move UP from there — to an appointment, an opt-out or a bad number
 * — and never down to a no-answer or voicemail, because this path exists to
 * stop repeat dials, not to manufacture negative outcomes. Absence of evidence
 * is still not evidence; the reaper already owns silence.
 *
 * ⚠️ These patterns are written against label values nobody has confirmed yet.
 * Run `npm run reactivate:reconcile:dry` and read the printed breakdown before
 * letting this write anything.
 */
const OUTCOME_PATTERNS = [
  [/opt.?out|unsubscrib|\bdnc\b|do.?not.?(contact|call)|remove.?me/, 'opted_out'],
  [/appointment|appt|booked|meeting|consult/,                          'appointment'],
  [/invalid|disconnect|wrong.?number|bad.?number|not.?in.?service/,    'bad_number'],
];

export function mapIngestOutcome(raw) {
  const text = String(raw ?? '').toLowerCase().trim();
  if (!text) return 'reached';
  for (const [pattern, outcome] of OUTCOME_PATTERNS) {
    if (pattern.test(text)) return outcome;
  }
  return 'reached';
}

/**
 * Work out how to join `contacts` to `re_contact`.
 * Returns { ok, by, column, available } — `by` is 'fub_id' or 'phone'.
 *
 * ── WHY THIS CHECKS FOR DATA AND NOT JUST FOR A COLUMN ────────────────────
 *
 * The first version of this took the first candidate column that EXISTED on
 * `contacts`. That is not the same question. `fub_person_id` exists on that
 * table and is NULL on every row the SimpleTalk ingest writes, so the join
 * resolved to `ct.fub_person_id = rc.fub_person_id`, matched zero rows, and
 * reported "nothing to reconcile" — indistinguishable from a quiet night. On
 * 2026-08-10 that swallowed 60 real conversations, two of them appointments,
 * and left all 60 queued for a second dial. A column existing is not evidence
 * it is usable; only data is. So each candidate is now probed against the rows
 * that actually matter (those carrying a bot_call_at) and skipped if empty.
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

  const outcomeColumn = OUTCOME_COLUMNS.find(has) || null;

  /** How many rows with a real conversation actually carry this column? */
  const populated = async (c) => {
    const { rows: [r] } = await db.query(
      `SELECT count(*)::int AS n FROM contacts
        WHERE ${c} IS NOT NULL AND bot_call_at IS NOT NULL`);
    return r.n;
  };

  // An explicit override always wins — the escape hatch for when the probe
  // below guesses wrong and there is no time to argue with it.
  const forced = process.env.RE_RECONCILE_LINK_COLUMN;
  if (forced) {
    if (!has(forced)) {
      return { ok: false, reason: `RE_RECONCILE_LINK_COLUMN=${forced} is not a column on contacts`, available };
    }
    const by = FUB_ID_COLUMNS.includes(forced) ? 'fub_id' : 'phone';
    return { ok: true, by, column: forced, outcomeColumn, available, forced: true };
  }

  // Remembered while probing, so an unpopulated table can still be joined
  // rather than abandoned. See the fallback below.
  let firstExisting = null;

  for (const c of FUB_ID_COLUMNS) {
    if (!has(c)) continue;
    if (!firstExisting) firstExisting = { by: 'fub_id', column: c };
    const n = await populated(c);
    if (n > 0) return { ok: true, by: 'fub_id', column: c, outcomeColumn, available, populated: n };
    console.warn(`[reconcile] contacts.${c} exists but is NULL on every row with a ` +
      `bot_call_at — not usable as a link, trying the next candidate`);
  }

  for (const c of PHONE_COLUMNS) {
    if (!has(c)) continue;
    if (!firstExisting) firstExisting = { by: 'phone', column: c };
    const n = await populated(c);
    if (n > 0) return { ok: true, by: 'phone', column: c, outcomeColumn, available, populated: n };
    console.warn(`[reconcile] contacts.${c} exists but is NULL on every row with a ` +
      `bot_call_at — not usable as a link, trying the next candidate`);
  }

  // ── WHY THIS FALLS BACK INSTEAD OF FAILING ────────────────────────────────
  //
  // "No column carries data" is not the same as "no column is usable". It is
  // the normal state of a fresh install, and of any day the ingest has not
  // written to yet. An earlier version returned ok:false here, which switched
  // the reconciler off entirely in that situation — worse than a join that
  // matches nothing, because a join matching nothing still picks up the first
  // real row the moment it lands, whereas skipping does not.
  if (firstExisting) {
    console.warn(`[reconcile] no candidate link column carries data yet — ` +
      `provisionally joining on contacts.${firstExisting.column}`);
    return { ok: true, ...firstExisting, outcomeColumn, available, populated: 0 };
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

  const outcomeSelect = link.outcomeColumn
    ? `ct.${link.outcomeColumn}::text AS ingest_outcome`
    : `NULL::text AS ingest_outcome`;

  const { rows: matches } = await db.query(
    `SELECT DISTINCT rc.id, rc.phone_e164, ct.bot_call_at, ${outcomeSelect}
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

  // Map before doing anything, so a dry run shows exactly what would be written.
  for (const m of matches) m.mapped = mapIngestOutcome(m.ingest_outcome);

  const tally = matches.reduce((acc, m) => {
    acc[m.mapped] = (acc[m.mapped] || 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');

  if (dryRun) {
    console.log(`[reconcile] DRY RUN — would resolve ${matches.length} contact(s) ` +
      `via ${link.by} on contacts.${link.column}: ${breakdown}`);
    for (const m of matches) {
      console.log(`  ${m.phone_e164} -> ${m.mapped}` +
        (m.ingest_outcome ? ` (ingest label: ${m.ingest_outcome})` : ' (no ingest label; floor is reached)'));
    }
    return { skipped: false, matched: matches.length, applied: 0, tally, link };
  }

  let applied = 0;
  for (const m of matches) {
    try {
      await apply(db, { contactId: m.id, outcome: m.mapped });
      applied++;
    } catch (err) {
      console.error(`[reconcile] failed on contact ${m.id}: ${err.message}`);
    }
  }

  console.log(`[reconcile] ${applied}/${matches.length} resolved from the SimpleTalk ` +
    `ingest (link: ${link.by} on contacts.${link.column}): ${breakdown}`);
  return { skipped: false, matched: matches.length, applied, tally, link };
}
