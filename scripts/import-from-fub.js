/**
 * Import from Follow Up Boss into re_contact, applying the verified targeting rule.
 *
 *   node scripts/import-from-fub.js --dry-run    # print the breakdown, write nothing
 *   node scripts/import-from-fub.js              # write to re_contact
 *
 * ── TARGETING RULE (verified against the live account, 6 Aug 2026) ──────────
 *
 * Include a person only if ALL of these hold:
 *   1. They have a parseable, non-duplicate phone number.
 *   2. They are owned by a TARGET user — by default Jake (id 37), the ISA.
 *   3. They are not in a do-not-contact or non-lead pond.
 *   4. They are not in a do-not-contact stage.
 *   5. They are not in active pipeline (mid-transaction with the team).
 *
 * WHY "OWNED BY JAKE" RATHER THAN "UNASSIGNED":
 * There are ZERO unassigned records in this database — every one of the 31,416
 * has an owner. Jake holds 25,890 of them (82%) as the default owner of
 * unworked leads. So "not yet assigned to a selling agent" is operationally
 * expressed as "still sitting with Jake". Filtering on unassigned would return
 * nothing at all.
 *
 * Verified result: 31,416 scanned -> 23,563 target.
 *   3,903 held by real agents · 1,921 bad/duplicate phone
 *   1,106 DNC ponds · 144 DNC stages · 779 active pipeline
 *
 * Note the FUB API quirks this works around: the `pondId` filter is silently
 * ignored (returns the whole database), and the `fields` parameter returns
 * HTTP 400. So we request full records and page via FUB's own nextLink.
 */

import { makePool } from '../src/reactivation/db.js';
import * as fub from '../src/reactivation/adapters/fub.js';
import { resolveTimezone } from '../src/reactivation/timezone.js';

const DRY = process.argv.includes('--dry-run');
const DAY = 86400000;

/** Users whose records are in scope. Jake (37) is the ISA / default holder. */
const TARGET_USER_IDS = new Set(
  (process.env.RE_TARGET_USER_IDS || '37').split(',').map((s) => Number(s.trim())).filter(Boolean));

/** Also accept genuinely unassigned records, should any ever appear. */
const INCLUDE_UNASSIGNED = process.env.RE_INCLUDE_UNASSIGNED !== 'false';

/**
 * Ponds excluded from dialing.
 *   4  Do Not Contact                                    (988)
 *   50 Zillow Nurture Team *claimed Leads* DO NOT PROSPECT (118)
 *   55 Madison's Recruiting Pond — agent recruiting, not home buyers (157)
 *   5  Vendor — vendors, not leads                          (2)
 */
const EXCLUDE_PONDS = new Set(
  (process.env.RE_EXCLUDE_PONDS || '4,50,55,5').split(',').map((s) => Number(s.trim())).filter(Boolean));

const DNC_STAGES = new Set((process.env.RE_DNC_STAGES ||
  'Archive (do not contact for 1 year +),Contact (NOT A LEAD/do not follow up),Trash')
  .split(',').map((s) => s.trim().toLowerCase()));

const ACTIVE_STAGES = new Set((process.env.RE_ACTIVE_STAGES ||
  'Appointment set,Showing homes,Listing agreement,Active listing,Submitting offers,Under contract')
  .split(',').map((s) => s.trim().toLowerCase()));

/** Past clients get their own cohort — they know you, so the script differs. */
const PAST_CLIENT_STAGES = new Set(['closed', 'met with customer']);

// ---------------------------------------------------------------------------

function pondIdsOf(person) {
  const ids = new Set();
  if (person.assignedPondId) ids.add(Number(person.assignedPondId));
  for (const m of person.pondMembers || []) {
    const id = Number(m && typeof m === 'object' ? m.pondId : m);
    if (id) ids.add(id);
  }
  return ids;
}

function ageDays(person) {
  const v = person.created || person.updated;
  if (!v) return 99999;
  const t = Date.parse(v);
  return Number.isFinite(t) ? (Date.now() - t) / DAY : 99999;
}

function cohortOf(person) {
  const stage = (person.stage || '').toLowerCase();
  if (PAST_CLIENT_STAGES.has(stage)) return 'past_client';
  const a = ageDays(person);
  if (a <= 90) return 'recent_0_90';
  if (a <= 365) return 'recent_91_365';
  if (a <= 1095) return 'dormant_1_3y';
  return 'dormant_3y';
}

/**
 * Priority within a wave. Recency dominates; a past-client relationship and
 * seller intent both earn a bump.
 */
function priorityScore(person, ponds) {
  const a = ageDays(person);
  let score = Math.max(0, 100 - a / 15);
  const stage = (person.stage || '').toLowerCase();
  if (stage === 'closed') score += 30;
  if (stage === 'met with customer') score += 20;
  if (stage === 'spoke with customer') score += 15;
  if (ponds.has(29) || ponds.has(77)) score += 15;   // Sellers, Zillow Seller Leads
  if (ponds.has(78)) score += 10;                    // Zillow - Hot Leads
  if (ponds.has(49)) score += 5;                     // Empty Nesters
  return Math.round(score);
}

// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.FUB_API_KEY) throw new Error('FUB_API_KEY is not set');
  const db = DRY ? null : makePool();

  const seenPhones = new Set();
  const stats = {
    scanned: 0, target: 0,
    ex_agent: 0, ex_phone: 0, ex_pond: 0, ex_dncStage: 0, ex_active: 0,
  };
  const byCohort = {}, byPond = {}, byStage = {}, byOwner = {}, byTz = {};
  let inPond = 0, noPond = 0;

  for await (const page of fub.iteratePeople({ limit: 100 })) {
    for (const person of page) {
      stats.scanned++;

      const owner = person.assignedTo || '(unassigned)';
      byOwner[owner] = (byOwner[owner] || 0) + 1;

      const ponds = pondIdsOf(person);
      const stage = (person.stage || '').toLowerCase();

      // Order matters: suppression-style exclusions first, so the counts are
      // directly comparable to the verified scan.
      if ([...ponds].some((id) => EXCLUDE_PONDS.has(id))) { stats.ex_pond++; continue; }
      if (DNC_STAGES.has(stage)) { stats.ex_dncStage++; continue; }
      if (ACTIVE_STAGES.has(stage)) { stats.ex_active++; continue; }

      const raw = (person.phones || []).find((p) => p.value)?.value;
      const phone = fub.normalizeE164(raw);
      if (!phone || seenPhones.has(phone)) { stats.ex_phone++; if (phone) seenPhones.add(phone); continue; }
      seenPhones.add(phone);

      const uid = person.assignedUserId ? Number(person.assignedUserId) : null;
      const ownedByTarget = uid !== null && TARGET_USER_IDS.has(uid);
      const unassigned = uid === null;
      if (!ownedByTarget && !(unassigned && INCLUDE_UNASSIGNED)) { stats.ex_agent++; continue; }

      stats.target++;
      if (ponds.size) { inPond++; for (const id of ponds) byPond[id] = (byPond[id] || 0) + 1; }
      else noPond++;

      const cohort = cohortOf(person);
      byCohort[cohort] = (byCohort[cohort] || 0) + 1;

      // COMPLIANCE: the dial-window check enforces 8am-8pm in the CONTACT's
      // local time, which only means anything if this is right. Address state
      // first, then area code, then flagged unknown (mid-morning window only).
      const tz = resolveTimezone({ addresses: person.addresses, phoneE164: phone });
      byTz[tz.source] = (byTz[tz.source] || 0) + 1;
      byStage[person.stage || '(none)'] = (byStage[person.stage || '(none)'] || 0) + 1;

      if (!DRY) {
        await db.query(
          `INSERT INTO re_contact
             (fub_person_id, first_name, last_name, phone_e164, email,
              cohort_code, priority_score, consent_tier, timezone, tz_source, next_eligible_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           ON CONFLICT (fub_person_id) DO UPDATE
             SET cohort_code = EXCLUDED.cohort_code,
                 priority_score = EXCLUDED.priority_score,
                 phone_e164 = EXCLUDED.phone_e164,
                 timezone = EXCLUDED.timezone,
                 tz_source = EXCLUDED.tz_source,
                 updated_at = now()`,
          [
            person.id,
            person.firstName || (person.name || '').split(' ')[0] || null,
            person.lastName || (person.name || '').split(' ').slice(1).join(' ') || null,
            phone,
            (person.emails || [])[0]?.value || null,
            cohort,
            priorityScore(person, ponds),
            'ebr_expired',   // counsel cleared all non-DNC records; tier retained for audit
            tz.timezone,
            tz.source,
          ],
        );
      }
    }
    process.stdout.write(`\r  scanned ${stats.scanned}  target ${stats.target}`);
  }

  // SHORT-READ GUARD.
  //
  // The first real run of this import died at exactly 2,000 records: FUB
  // disables offset pagination past that point and returns a 400. That failure
  // was loud, which is the only reason it was caught. The dangerous version of
  // the same bug is the quiet one — a walk that stops early WITHOUT erroring,
  // leaving most of the database unimported while every number on screen looks
  // plausible. Those people would simply never be called, and the burndown
  // would report the program finished.
  //
  // So: ask FUB how many people it thinks it has, and refuse if we saw
  // materially fewer.
  const expectedTotal = await fub.countPeople().catch(() => null);
  if (expectedTotal && stats.scanned < expectedTotal * 0.95) {
    throw new Error(
      `SHORT READ: scanned ${stats.scanned} of ${expectedTotal} people in Follow Up Boss ` +
      `(${Math.round((100 * stats.scanned) / expectedTotal)}%). Pagination stopped early. ` +
      `Refusing to import a partial database — the missing people would never be called ` +
      `and nothing downstream would show they were missing.`);
  }

  const line = (k, v) => console.log(`  ${String(k).padEnd(38)} ${String(v).padStart(7)}`);
  console.log('\n\n' + '='.repeat(56));
  console.log(`  FUB IMPORT ${DRY ? '(DRY RUN — nothing written)' : ''}`);
  console.log('='.repeat(56));
  line('scanned', stats.scanned);
  if (expectedTotal) line('  ...of FUB total', expectedTotal);
  console.log('  ' + '-'.repeat(46));
  line('excluded: held by a real agent', stats.ex_agent);
  line('excluded: bad or duplicate phone', stats.ex_phone);
  line('excluded: DNC / non-lead pond', stats.ex_pond);
  line('excluded: DNC stage', stats.ex_dncStage);
  line('excluded: active pipeline', stats.ex_active);
  console.log('  ' + '-'.repeat(46));
  line('TARGET', stats.target);
  line('  ...in a pond', inPond);
  line('  ...not in a pond', noPond);

  console.log('\n  BY TIMEZONE SOURCE  <-- compliance: unknown = mid-morning window only');
  for (const [k, v] of Object.entries(byTz).sort((a, b) => b[1] - a[1])) line(k, v);

  console.log('\n  BY COHORT');
  for (const [k, v] of Object.entries(byCohort).sort((a, b) => b[1] - a[1])) line(k, v);
  console.log('\n  BY STAGE');
  for (const [k, v] of Object.entries(byStage).sort((a, b) => b[1] - a[1])) line(k.slice(0, 38), v);
  console.log('\n  BY POND (target only)');
  for (const [k, v] of Object.entries(byPond).sort((a, b) => b[1] - a[1])) line(`pond ${k}`, v);
  console.log('\n  TOP OWNERS (all records, before filtering)');
  for (const [k, v] of Object.entries(byOwner).sort((a, b) => b[1] - a[1]).slice(0, 10)) line(k, v);

  console.log('\n  Expected from the 6 Aug verified scan: target 23,563 ' +
    '(minus ~159 now that recruiting and vendor ponds are excluded).');
  console.log('  A materially different number means the API contract changed — investigate.\n');

  if (db) await db.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
