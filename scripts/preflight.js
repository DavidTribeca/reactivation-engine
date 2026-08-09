/**
 * Preflight — one command that answers "can this go live, and if not, why not".
 *
 *   node scripts/preflight.js
 *
 * Written for the morning of launch. Everything it checks is something that has
 * either blocked this program already or would have failed silently: a token
 * with read-only scopes, a workflow id nobody set, an empty caller pool, a
 * schema that never got applied, a link column on someone else's table that
 * this code had to guess at.
 *
 * Exits 0 when every BLOCKER passes, 1 otherwise, so it can gate a deploy.
 * Warnings never fail the run — they are things to know, not things to stop for.
 *
 * Read-only. It makes no writes and places no calls. Safe to run any time,
 * including against a live program.
 */

import { makePool, programDate, TZ } from '../src/reactivation/db.js';
import { resolveLink } from '../src/reactivation/reconcile.js';
import { measureRolloverPct } from '../src/reactivation/adapters/isa-list.js';
import { DISPATCH_SLOTS } from '../src/reactivation/schedule.js';

const results = [];
const add = (level, name, ok, detail, fix) =>
  results.push({ level, name, ok, detail, fix });

const BLOCKER = 'BLOCKER';
const WARN = 'WARNING';
const INFO = 'INFO';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — nothing to check against.');
    process.exit(1);
  }
  const db = makePool({ max: 3 });

  // ---- 1. Schema -------------------------------------------------------
  const { rows: tables } = await db.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name LIKE 're\\_%'`);
  const names = tables.map((t) => t.table_name);
  const required = ['re_cohort', 're_contact', 're_attempt', 're_suppression',
    're_daily_release', 're_caller_number', 're_control', 're_sync_state'];
  const missing = required.filter((t) => !names.includes(t));
  add(BLOCKER, 'Schema applied', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${names.length} re_ tables present`,
    'Deploy the service — it applies migrations on boot. Or run migrations/*.sql by hand.');

  // ---- 2. Program day agreement ---------------------------------------
  const { rows: [pd] } = await db.query(
    `SELECT current_setting('TimeZone') AS tz, current_date::text AS today`);
  add(BLOCKER, 'Postgres and the app agree on today', pd.today === programDate(),
    `postgres=${pd.today} app=${programDate()} tz=${pd.tz}`,
    'Connections must be made through makePool() so the session timezone is set.');

  // ---- 3. The master switch -------------------------------------------
  let dialing = false;
  try {
    const { rows: [d] } = await db.query(`SELECT re_dialing_enabled() AS on`);
    dialing = d.on;
  } catch { /* schema missing — already reported above */ }
  add(INFO, 'Dialing switch', true,
    dialing ? 'ON — the dispatcher will place calls on its next scheduled run'
            : 'OFF — nothing will be dialled until you turn it on',
    dialing ? 'Turn off with: run-dispatch.js stop "reason"'
            : 'Turn on with: run-dispatch.js resume');

  // ---- 4. Who is loaded ------------------------------------------------
  let contactCount = 0;
  try {
    const { rows: [c] } = await db.query(`SELECT count(*)::int AS n FROM re_contact`);
    contactCount = c.n;
  } catch { /* handled by schema check */ }
  add(BLOCKER, 'Contacts imported', contactCount > 0,
    `${contactCount.toLocaleString()} in the program`,
    'Run: node scripts/import-from-fub.js --dry-run   then without --dry-run');

  if (contactCount > 0) {
    const { rows: byCohort } = await db.query(
      `SELECT cohort_code, count(*)::int AS n FROM re_contact
        GROUP BY cohort_code ORDER BY n DESC`);
    add(INFO, 'Cohort split', true,
      byCohort.map((r) => `${r.cohort_code}=${r.n}`).join('  '), null);

    const { rows: [tz] } = await db.query(
      `SELECT count(*) FILTER (WHERE tz_source='default_unknown')::int AS unknown,
              count(*)::int AS total FROM re_contact`);
    const pct = tz.total ? Math.round((100 * tz.unknown) / tz.total) : 0;
    add(pct > 40 ? WARN : INFO, 'Timezone coverage', pct <= 40,
      `${pct}% could not be placed — those are restricted to mid-morning only`,
      pct > 40 ? 'Not blocking, but it caps how much of the day they can be called in.' : null);
  }

  // ---- 5. Suppression --------------------------------------------------
  try {
    const { rows: [s] } = await db.query(
      `SELECT (SELECT count(*)::int FROM re_suppression) AS n,
              re_suppression_is_fresh(120) AS fresh,
              (SELECT last_ok_at FROM re_sync_state WHERE key='suppression') AS last_ok`);
    add(BLOCKER, 'Suppression list synced', s.n > 0 && s.fresh,
      `${s.n.toLocaleString()} suppressed, last successful sync ${s.last_ok || 'never'}`,
      'Run: node scripts/sync-suppression.js --full');
  } catch {
    add(BLOCKER, 'Suppression list synced', false, 'could not read', 'Apply the schema first.');
  }

  // ---- 6. Caller numbers ----------------------------------------------
  try {
    const { rows: [n] } = await db.query(
      `SELECT count(*)::int AS active, COALESCE(sum(daily_cap),0)::int AS capacity
         FROM re_caller_number WHERE active`);
    add(BLOCKER, 'Caller numbers', n.active > 0,
      `${n.active} active, ${n.capacity} dials/day of capacity`,
      "INSERT INTO re_caller_number (phone_e164, label, daily_cap) VALUES ('+1206...','seattle-1',110);");
    if (n.active > 0 && n.active < 8) {
      add(WARN, 'Caller number pool is thin', false,
        `${n.active} numbers — 8 to 10 recommended at full volume`,
        'At 750 dials/day across fewer numbers, carriers flag them. Once flagged, a number is dead.');
    }
  } catch { /* schema */ }

  // ---- 7. GoHighLevel — the actuator ----------------------------------
  const token = process.env.GHL_API_TOKEN;
  const workflow = process.env.GHL_SIMPLETALK_WORKFLOW_ID;
  const location = process.env.GHL_LOCATION_ID;

  add(BLOCKER, 'GHL workflow id set', !!workflow,
    workflow ? `${workflow.slice(0, 8)}…` : 'GHL_SIMPLETALK_WORKFLOW_ID is not set',
    'Open the dialer workflow in GHL and copy the id from the URL. Without it there is ' +
    'nowhere to push contacts, so nothing can be dialled.');
  add(BLOCKER, 'GHL location id set', !!location,
    location ? `${location.slice(0, 8)}…` : 'GHL_LOCATION_ID is not set', 'Set it in Railway.');

  if (!token) {
    add(BLOCKER, 'GHL token', false, 'GHL_API_TOKEN is not set', 'Set it in Railway.');
  } else {
    // Live scope check. A read-only token is the exact failure this program
    // has already hit once, and it does not surface until the first push
    // returns 401 — by which time the dispatcher thinks it dialled.
    try {
      const res = await fetch(
        `https://services.leadconnectorhq.com/locations/${location}/customFields`,
        { headers: {
          Authorization: `Bearer ${token}`,
          Version: process.env.GHL_API_VERSION || '2021-07-28',
          Accept: 'application/json',
          // Cloudflare sits in front of GHL and rejects requests with no
          // User-Agent. Set explicitly rather than trusting the runtime.
          'User-Agent': process.env.RE_USER_AGENT || 'tribeca-reactivation-engine/1.0',
        } });

      const body = await res.text().catch(() => '');
      // "Cannot reach GHL from this machine" and "GHL rejected this token" are
      // completely different problems with completely different fixes, and
      // reporting a sandbox egress block as an invalid token sends you off
      // regenerating a token that was fine.
      const unreachable = /allowlist|egress|ENOTFOUND|ECONNREFUSED|proxy/i.test(body);
      if (unreachable) {
        add(WARN, 'GHL token is valid', false,
          `could not reach GHL from this machine (HTTP ${res.status}) — not a token problem`,
          'Run preflight from the Railway service, which has open outbound access.');
      } else {
        add(BLOCKER, 'GHL token is valid', res.ok,
          `read check returned HTTP ${res.status}`,
          res.ok ? null
            : 'GHL rejected the token. Regenerate it in GHL → Settings → Private Integrations.');
      }

      // The write scope cannot be proven without writing, and writing here
      // would enrol a real person and place a real call. Report it as unknown
      // rather than implying it passed.
      add(WARN, 'GHL write scopes', false,
        'not provable without a write — the last token checked was read-only',
        'Confirm contacts.write, workflows.readonly and workflows.write are ticked on the ' +
        'token. Then verify against ONE deliberately-created test contact, never a live record.');
    } catch (err) {
      add(BLOCKER, 'GHL token is valid', false, `request failed: ${err.message}`,
        'Check the token and network access.');
    }
  }

  // ---- 8. Follow Up Boss ----------------------------------------------
  add(BLOCKER, 'FUB key set', !!process.env.FUB_API_KEY,
    process.env.FUB_API_KEY ? 'present' : 'FUB_API_KEY is not set',
    'Needed for the import and for the suppression sync.');

  // ---- 9. The outcome path --------------------------------------------
  const link = await resolveLink(db);
  add(link.ok ? INFO : WARN, 'Outcome reconciler link', link.ok,
    link.ok
      ? `matching on contacts.${link.column} (by ${link.by})`
      : `${link.reason}${link.available?.length ? ` — columns are: ${link.available.join(', ')}` : ''}`,
    link.ok ? null
      : 'Without this, outcomes depend entirely on GHL webhooks whose event names are ' +
        'unverified. Add the right column name to reconcile.js.');

  const roll = await measureRolloverPct(db);
  add(INFO, 'Rollover signal', true,
    roll.pct === null ? `unavailable — ${roll.reason}` : `${(roll.pct * 100).toFixed(1)}%`,
    roll.pct === null ? 'Normal before launch; it needs escalations to measure.' : null);

  // ---- 10. Alerting ----------------------------------------------------
  add(WARN, 'Alert webhook', !!process.env.RE_ALERT_WEBHOOK,
    process.env.RE_ALERT_WEBHOOK ? 'set' : 'RE_ALERT_WEBHOOK is not set',
    'Every safety mechanism here fails closed, which means the program can stop safely and ' +
    'silently. Without this, a halt at 2am looks identical to a quiet day.');

  // ---- 11. Launch guardrails ------------------------------------------
  const onlyCohorts = process.env.RE_ONLY_COHORTS || '';
  const onlyWindows = process.env.RE_ONLY_WINDOWS || '';
  const cap = process.env.DAILY_CAP || '(unset — defaults to 100)';
  add(INFO, 'Launch guardrails', true,
    `DAILY_CAP=${cap}  RE_ONLY_COHORTS=${onlyCohorts || '(none)'}  ` +
    `RE_ONLY_WINDOWS=${onlyWindows || '(none)'}`,
    (!onlyCohorts || !onlyWindows)
      ? 'For the first live day the plan is one cohort, mid-morning only: ' +
        'RE_ONLY_COHORTS=hot_engaged RE_ONLY_WINDOWS=mid_morning DAILY_CAP=100'
      : null);

  add(INFO, 'Dispatch schedule', true,
    DISPATCH_SLOTS.map((s) => `${s.name.replace('dispatch-', '')} ${s.hour}:00 ` +
      `[${s.dows.join(',')}]`).join('   ') + `  ${TZ}`, null);

  await db.end();

  // ---- report ----------------------------------------------------------
  const blockers = results.filter((r) => r.level === BLOCKER && !r.ok);
  const warnings = results.filter((r) => r.level === WARN && !r.ok);

  console.log('\n══ PREFLIGHT ══════════════════════════════════════════════════\n');
  for (const r of results) {
    const mark = r.level === INFO ? '·' : r.ok ? '✓' : (r.level === BLOCKER ? '✗' : '!');
    console.log(`  ${mark} ${r.name.padEnd(34)} ${r.detail}`);
  }

  if (blockers.length || warnings.length) {
    console.log('\n── what to do ────────────────────────────────────────────────\n');
    for (const r of [...blockers, ...warnings]) {
      if (!r.fix) continue;
      console.log(`  ${r.level === BLOCKER ? '✗' : '!'} ${r.name}`);
      console.log(`      ${r.fix}\n`);
    }
  }

  const verdict = blockers.length === 0;
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(verdict
    ? `  READY — ${warnings.length} warning(s), no blockers.`
    : `  NOT READY — ${blockers.length} blocker(s): ${blockers.map((b) => b.name).join(', ')}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  process.exit(verdict ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
