/**
 * Follow Up Boss adapter — FUB stays the CRM of record.
 *
 * The engine writes back to FUB so your team sees state where they already
 * work, and so the "stop ai call" tag remains the single source of truth for
 * "do not let the bot touch this person".
 *
 * ⚠️ IMPORTANT — tag replacement
 * FUB's PUT /people/{id} replaces the tags array rather than appending. This
 * adapter therefore does read-merge-write. Never PUT a bare tags array or you
 * will wipe every tag the team has applied.
 */

const BASE = 'https://api.followupboss.com/v1';

/** FUB uses HTTP Basic with the API key as username and an empty password. */
function authHeader() {
  const token = Buffer.from(`${process.env.FUB_API_KEY}:`).toString('base64');
  return `Basic ${token}`;
}

function headers() {
  return {
    'Authorization': authHeader(),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-System': 'reactivation-engine',
  };
}

async function fubFetch(path, options = {}, { retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, { ...options, headers: headers() });

      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 2 ** i * 1000;
        await sleep(wait);
        lastErr = new Error(`FUB ${res.status} on ${path}`);
        continue;
      }

      const body = await res.text();
      if (!res.ok) throw new Error(`FUB ${res.status} on ${path}: ${body.slice(0, 400)}`);
      return body ? JSON.parse(body) : {};
    } catch (err) {
      lastErr = err;
      if (i === retries - 1) break;
      await sleep(2 ** i * 1000);
    }
  }
  throw lastErr;
}

/**
 * How many people FUB thinks the account has.
 *
 * Used as the denominator for the import's short-read guard. Cheap: asks for a
 * single record and reads the collection total out of the metadata.
 */
export async function countPeople() {
  const page = await fubFetch('/people?limit=1');
  const md = page._metadata || {};
  const total = md.total ?? md.count ?? null;
  return typeof total === 'number' ? total : null;
}

export async function getPerson(personId) {
  return fubFetch(`/people/${personId}?fields=id,name,tags,phones,emails,stage,source`);
}

/**
 * Add tags without destroying existing ones.
 */
export async function addTags(personId, tagsToAdd) {
  const person = await getPerson(personId);
  const existing = Array.isArray(person.tags) ? person.tags : [];
  const merged = [...new Set([...existing, ...tagsToAdd])];

  // No change — skip the write entirely.
  if (merged.length === existing.length) return person;

  return fubFetch(`/people/${personId}`, {
    method: 'PUT',
    body: JSON.stringify({ tags: merged }),
  });
}

export async function removeTags(personId, tagsToRemove) {
  const person = await getPerson(personId);
  const existing = Array.isArray(person.tags) ? person.tags : [];
  const remove = new Set(tagsToRemove);
  const merged = existing.filter((t) => !remove.has(t));

  if (merged.length === existing.length) return person;

  return fubFetch(`/people/${personId}`, {
    method: 'PUT',
    body: JSON.stringify({ tags: merged }),
  });
}

/**
 * THE DIAL TRIGGER.
 *
 * This is what actually causes a call, and it is far simpler than the route
 * this engine was originally built around. Gabriel's manual process is: select
 * people in FUB → Mass Action → Apply Automation → "Send To Simpletalk". That
 * automation has exactly one step: add the tag `ai call`. The tag is what makes
 * the phone ring. The automation is only a way to apply it to many people at
 * once — for one person at a time over the API, the tag alone is the whole job.
 *
 * So the actuator is a FUB tag write, not a GHL workflow enrolment. That
 * removes the two unverified GHL endpoints from the dial path entirely, and
 * means dialing does not depend on the GHL token's write scopes at all.
 *
 * ── WHY IT REMOVES THE TAG FIRST ──────────────────────────────────────────
 *
 * addTags() skips the write when the tag is already present, and the trigger
 * downstream is near-certainly "tag was added" rather than "tag is present".
 * On attempt 2 the person still carries `ai call` from attempt 1, so a plain
 * addTags() would write nothing, fire nothing, and report success. Every
 * retry in the ladder would silently do nothing while the queue advanced as
 * though the call had been placed.
 *
 * Removing then re-adding guarantees a genuine add event every time.
 *
 * ⚠️ VERIFY ON THE FIRST TEST CONTACT: confirm that attempt 2 actually dials.
 * If the downstream trigger turns out to be "has tag" rather than "tag added",
 * this needs rethinking — and in that case leaving the tag on would cause
 * repeat calls, so it must be checked before any volume.
 */
export async function triggerAiCall(personId, { tag = AI_CALL_TAG } = {}) {
  await removeTags(personId, [tag]);
  return addTags(personId, [tag]);
}

/** The tag that makes SimpleTalk dial. Must match the FUB automation exactly. */
export const AI_CALL_TAG = process.env.RE_AI_CALL_TAG || 'ai call';

/**
 * The kill switch. Applied the instant someone is reached, books, or opts out.
 * Mirrors the tag you apply by hand today.
 */
export async function applyStopAiCall(personId, reason) {
  const tags = ['stop ai call'];
  if (reason) tags.push(`ai-stop-${reason}`);   // e.g. ai-stop-reached, ai-stop-opted_out
  return addTags(personId, tags);
}

/** Marks which wave/cohort a person is in, so the team can see it in FUB. */
export async function tagCohort(personId, { wave, cohortCode }) {
  return addTags(personId, [`ai-wave-${wave}`, `ai-cohort-${cohortCode}`]);
}

/**
 * Log the bot attempt to FUB's timeline so the ISA has context before calling.
 * Uses the notes endpoint — verify the shape against your FUB plan's API access.
 */
export async function logNote(personId, body) {
  return fubFetch('/notes', {
    method: 'POST',
    body: JSON.stringify({ personId, subject: 'AI dial attempt', body }),
  });
}

// ---------------------------------------------------------------------------
// Suppression sync
// ---------------------------------------------------------------------------
/**
 * Suppression config — VERIFIED against the live FUB account on 6 Aug 2026.
 *
 *   Pond 4  "Do Not Contact"                                     988 people
 *   Pond 50 "Zillow Nurture Team *claimed Leads*(DO NOT PROSPECT)"  118 people
 *   Pond 55 "Madison's Recruiting Pond" — agent recruiting, not buyers  157 people
 *   Pond 5  "Vendor" — vendors, not leads                           2 people
 */
export const DNC_POND_IDS = (process.env.RE_DNC_POND_IDS || '4,50,55,5')
  .split(',').map((s) => Number(s.trim())).filter(Boolean);

/** Stages that must never be bot-dialed. Verified counts in comments. */
export const DNC_STAGES = (process.env.RE_DNC_STAGES ||
  'Archive (do not contact for 1 year +),Contact (NOT A LEAD/do not follow up),Trash')
  .split(',').map((s) => s.trim()).filter(Boolean);   // 70 + 132 + 0

/**
 * Active pipeline — someone mid-transaction with your team must never receive a
 * cold bot call. Verified: 344 + 303 + 41 + 19 + 47 + 29 = 783 people.
 */
export const ACTIVE_STAGES = (process.env.RE_ACTIVE_STAGES ||
  'Appointment set,Showing homes,Listing agreement,Active listing,Submitting offers,Under contract')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Mirror FUB's do-not-contact ponds and no-call stages into re_suppression.
 *
 * ⚠️ WHY THIS SCANS RECORDS INSTEAD OF USING A SERVER-SIDE FILTER
 * FUB's API SILENTLY IGNORES the `pondId` query parameter. Verified 6 Aug 2026:
 * `/people?pondId=4`, `?pond=4` and `?pondIds=4` each returned all 31,415
 * records with no error at all. An earlier version of this function trusted
 * that filter, which would have inserted every phone number in the database
 * into re_suppression on first run and permanently halted all dialing.
 *
 * Pond membership is therefore read off each person record via `assignedPondId`
 * and `pondMembers`, which ARE reliable.
 *
 * Also note: the `fields` parameter causes HTTP 400 on this account, so we
 * request full records and page via FUB's own nextLink.
 *
 * Two modes:
 *   incremental (default) — only records changed since the last successful sync,
 *     via `updatedAfter`, which the API does honour. Cheap enough to run every
 *     15 minutes — which matters, because ISAs trash people out of the pond and
 *     a slow sync can miss them entirely.
 *   full — every record. Run nightly as a reconciliation backstop.
 */
export async function syncSuppression(db, { mode = 'incremental', since = null } = {}) {
  const pondSet = new Set(DNC_POND_IDS);
  const dncStages = new Set(DNC_STAGES.map((s) => s.toLowerCase()));
  const activeStages = new Set(ACTIVE_STAGES.map((s) => s.toLowerCase()));

  let path = '/people?limit=100';

  if (mode === 'incremental') {
    const cutoff = since || (await db.query(
      `SELECT COALESCE(last_ok_at, now() - interval '7 days') AS t
         FROM re_sync_state WHERE key = 'suppression'`)).rows[0]?.t;
    if (cutoff) {
      const iso = new Date(cutoff).toISOString().slice(0, 19) + 'Z';
      path += `&updatedAfter=${encodeURIComponent(iso)}`;
    }
  }

  let scanned = 0, added = 0, stopped = 0, matched = 0;

  while (path) {
    const page = await fubFetch(path);
    const people = page.people || [];
    if (!people.length) break;

    for (const person of people) {
      scanned++;

      // Pond membership — read from the record, never from a query filter.
      const ponds = new Set();
      if (person.assignedPondId) ponds.add(Number(person.assignedPondId));
      for (const m of person.pondMembers || []) {
        const id = Number(m && typeof m === 'object' ? m.pondId : m);
        if (id) ponds.add(id);
      }

      const stage = (person.stage || '').toLowerCase();
      const hitPonds = [...ponds].filter((id) => pondSet.has(id));
      const inDncPond = hitPonds.length > 0;
      const inDncStage = dncStages.has(stage);
      const inActiveStage = activeStages.has(stage);

      if (!inDncPond && !inDncStage && !inActiveStage) continue;
      matched++;

      const reason = inActiveStage && !inDncPond && !inDncStage
        ? 'client_active'
        : 'internal_dnc';
      const note = inDncPond
        ? `fub pond ${hitPonds.join(',')}`
        : `fub stage: ${person.stage}`;

      for (const phone of person.phones || []) {
        const e164 = normalizeE164(phone.value);
        if (!e164) continue;
        const res = await db.query(
          `INSERT INTO re_suppression (phone_e164, reason, source, note)
           VALUES ($1, $2, 'fub-sync', $3)
           ON CONFLICT (phone_e164) DO NOTHING`,
          [e164, reason, note],
        );
        added += res.rowCount;
      }

      const upd = await db.query(
        `UPDATE re_contact
            SET status = 'suppressed', suppressed_reason = $2, updated_at = now()
          WHERE fub_person_id = $1 AND status IN ('eligible','in_flight')`,
        [person.id, note],
      );
      stopped += upd.rowCount;
    }

    const md = page._metadata || {};
    const next = md.nextLink || md.next;
    path = next ? (next.startsWith('http') ? next.replace(BASE, '') : next) : null;
  }

  console.log(`[fub-sync:${mode}] scanned ${scanned}, matched ${matched}, ` +
    `+${added} suppressions, ${stopped} stopped mid-ladder`);
  return { mode, scanned, matched, added, stopped };
}

/**
 * Sanity guard for the full sync. On this account the expected suppression
 * population is roughly 988 + 118 + 70 + 132 + 783 ≈ 2,100 of 31,415 (~7%).
 * If a full scan ever wants to suppress a large share of the database, that is
 * far more likely to be an API contract change than a real business event —
 * so refuse and make a human look. This is the check that would have caught
 * the pondId bug before it halted the program.
 */
export function assertSuppressionSane({ scanned, matched }, maxShare = 0.25) {
  if (scanned > 500 && matched / scanned > maxShare) {
    throw new Error(
      `suppression sanity check failed: ${matched}/${scanned} ` +
      `(${(100 * matched / scanned).toFixed(1)}%) matched, above ${maxShare * 100}% ceiling. ` +
      `Suspect an API contract change. No suppression written.`);
  }
  return true;
}

/** Shared with the importer — light US E.164 normalisation. */
export function normalizeE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/**
 * Paged people fetch, for the initial import and for nightly reconciliation.
 * Yields arrays of people.
 */
/**
 * Walk every person in the account, a page at a time.
 *
 * Follows FUB's own `_metadata.nextLink` cursor rather than incrementing an
 * offset. Offset paging works for the first 2,000 records and then FUB returns
 * a hard 400: "Deep pagination disabled, use 'nextLink' url". On an account
 * with 31,446 people that means an offset-based walk sees the first 6% and
 * then dies — which is exactly what the import did on its first real run.
 *
 * syncSuppression() has always used nextLink, which is why the suppression
 * sync scanned all 31,446 while the import stopped at 2,000. Same account,
 * same API, two different pagination strategies, one of them wrong.
 */
export async function* iteratePeople({ limit = 100, extraQuery = '' } = {}) {
  let path = `/people?limit=${limit}` +
    `&fields=id,name,tags,phones,emails,stage,source,created,lastActivity${extraQuery}`;

  while (path) {
    const page = await fubFetch(path);
    const people = page.people || [];
    if (people.length) yield people;

    // nextLink comes back absolute; fubFetch wants a path.
    const md = page._metadata || {};
    const next = md.nextLink || md.next;
    path = next ? (next.startsWith('http') ? next.replace(BASE, '') : next) : null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
