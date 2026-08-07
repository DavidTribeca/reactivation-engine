/**
 * Dry-run simulation / scenario sweep. No database, no API calls.
 *
 * Exercises the REAL ladder.js and throttle.js modules against a synthetic
 * 23,563-contact target set (verified against the live FUB account).
 *
 * ISA capacity is calibrated to MEASURED data from the contacts table
 * (queried 2026-08-06): 125 of 130 conversations were ultimately worked (96%),
 * and on 2026-07-31 the pod queued 85 conversations and completed all 85.
 * So sustained capacity is at least 40/day and demonstrably peaks at 85.
 *
 * An earlier version of this file assumed capacity of 30/day, inferred from
 * "[scheduler] rolled N uncalled contact(s)" log lines. That inference was
 * wrong: those lines record next-day DEFERRAL, not loss. Median time from bot
 * conversation to ISA completion is 6.1 hours.
 *
 * Two variables are under test: ESCALATION RATE (what share of conversations
 * become an ISA task) and ISA CAPACITY. The sweep shows program length is far
 * more sensitive to capacity than to escalation rate — and that filtering
 * escalations makes the timeline robust to whatever capacity turns out to be.
 *
 * Run: node scripts/simulate.js
 */

import {
  nextAttempt, isWithinDialWindow, localParts, localWallTimeToUtc,
  MAX_ATTEMPTS_PER_7_DAYS,
} from '../src/reactivation/ladder.js';
import { evaluate, nextTarget, RAMP } from '../src/reactivation/throttle.js';

const TZ = 'America/Los_Angeles';
const BLENDED_AR = 0.081;   // weighted mean of per-cohort rates below
const OPTOUT_RATE_OF_CONNECTS = 0.006;
const MAX_SIM_DAYS = 760;

// VERIFIED TARGET SET — full scan of the live FUB account, 6 Aug 2026.
// Targeting rule: good phone number AND held by Jake (user 37, the ISA) —
// which is the operative definition of "not yet assigned to a selling agent",
// because NOBODY in this database is formally unassigned. Jake holds 25,890 of
// 31,416 records as the catch-all owner of unworked leads.
//
// 31,416 scanned -> 23,563 target. Excluded: 3,903 held by real agents,
// 1,921 bad/duplicate phone, 1,106 DNC ponds (4/50), 144 DNC stages,
// 779 active pipeline. 21,110 of the target (89.6%) sit in a pond.
//
// answerRate is per-cohort: 70.7% of the target is over three years old.
const COHORTS = [
  { code: 'recent_0_90',   wave: 1, n: 403,   answerRate: 0.15 },
  { code: 'recent_91_365', wave: 2, n: 1281,  answerRate: 0.13 },
  { code: 'dormant_1_3y',  wave: 3, n: 5218,  answerRate: 0.10 },
  { code: 'dormant_3y',    wave: 4, n: 16661, answerRate: 0.07 },
];

const dayKey = (d) => d.toISOString().slice(0, 10);
const sum = (a) => a.reduce((s, x) => s + x, 0);

function runScenario({ label, escalationRate, isaCapacity }) {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const contacts = [];
  let id = 0;
  for (const c of COHORTS) {
    for (let i = 0; i < c.n; i++) {
      contacts.push({ id: id++, wave: c.wave, score: rand() * 100, ar: c.answerRate,
        attempts: 0, status: 'eligible', attemptDays: [] });
    }
  }
  const TOTAL = contacts.length;

  // Walk actual calendar dates; compute each day's dial instant as 10:00 local
  // so the simulated clock never drifts across a DST boundary.
  let y = 2026, mo = 9, d = 1;
  const pending = new Map();
  pending.set('2026-09-01', contacts.map((c) => c.id));

  let ready = [];
  let target = RAMP.floor, greenStreak = 0, day = 0;
  let totalDials = 0, peakTarget = RAMP.floor, leakedTotal = 0;
  const violations = { rolling7: 0, sunday: 0, outOfWindow: 0 };
  const hist = { esc: [], leak: [], resolved: [], connects: [], optOuts: [] };
  const trace = [];
  let idleDaysWithBacklog = 0;

  while (day < MAX_SIM_DAYS) {
    const dialAt = localWallTimeToUtc({ year: y, month: mo, day: d, hour: 10 }, TZ);
    const key = dayKey(dialAt);
    const dow = localParts(dialAt, TZ).dow;
    const isDialingDay = dow !== 0;
    const dayNum = Math.floor(dialAt.getTime() / 86400000);

    const arrived = pending.get(key);
    if (arrived) {
      for (const cid of arrived) if (contacts[cid].status === 'eligible') ready.push(cid);
      pending.delete(key);
      ready.sort((a, b) => contacts[a].wave - contacts[b].wave || contacts[b].score - contacts[a].score);
    }

    let pushed = 0, connects = 0, optOuts = 0, resolved = 0;

    if (isDialingDay && ready.length) {
      const take = [], deferred = [];
      for (const cid of ready) {
        if (take.length >= target) { deferred.push(cid); continue; }
        const c = contacts[cid];
        if (c.attemptDays.filter((x) => dayNum - x < 7).length >= MAX_ATTEMPTS_PER_7_DAYS) {
          deferred.push(cid); continue;
        }
        take.push(cid);
      }
      ready = deferred;

      for (const cid of take) {
        const c = contacts[cid];

        // Guardrail verification against the real ladder helpers.
        if (!isWithinDialWindow(dialAt, TZ)) violations.outOfWindow++;
        if (dow === 0) violations.sunday++;
        if (c.attemptDays.filter((x) => dayNum - x < 7).length >= MAX_ATTEMPTS_PER_7_DAYS) {
          violations.rolling7++;
        }

        c.attempts++; c.attemptDays.push(dayNum);
        if (c.attemptDays.length > 6) c.attemptDays.shift();
        pushed++; totalDials++; resolved++;

        if (rand() < c.ar) {
          connects++;
          if (rand() < OPTOUT_RATE_OF_CONNECTS) { c.status = 'opted_out'; optOuts++; }
          else c.status = 'reached';
        } else {
          const nx = nextAttempt(c.attempts, dialAt, TZ);
          if (!nx) c.status = 'exhausted';
          else {
            const k = dayKey(nx.runAt);
            if (!pending.has(k)) pending.set(k, []);
            pending.get(k).push(cid);
          }
        }
      }
    }

    if (isDialingDay && pushed === 0 && (ready.length || pending.size)) idleDaysWithBacklog++;

    // --- the constraint ---
    const escalations = connects * escalationRate;
    const leaked = Math.max(0, escalations - isaCapacity);
    leakedTotal += leaked;

    // trailing 7-day windows
    const push7 = (arr, v) => { arr.push(v); if (arr.length > 7) arr.shift(); };
    push7(hist.esc, escalations); push7(hist.leak, leaked);
    push7(hist.resolved, resolved); push7(hist.connects, connects); push7(hist.optOuts, optOuts);

    const verdict = evaluate({
      escalations7d: sum(hist.esc),
      leaked7d:      sum(hist.leak),
      resolved7d:    sum(hist.resolved),
      connects7d:    sum(hist.connects),
      optOuts7d:     sum(hist.optOuts),
      baselineAnswerRate: BLENDED_AR,
      consecutiveGreenDays: greenStreak,
    });

    greenStreak = verdict.state === 'green' ? greenStreak + 1 : 0;
    target = nextTarget(target, verdict);
    peakTarget = Math.max(peakTarget, target);

    if (day % 30 === 0) {
      trace.push({ day, target, pushed, connects,
        rollover: sum(hist.esc) ? sum(hist.leak) / sum(hist.esc) : 0, state: verdict.state });
    }

    if (ready.length === 0 && pending.size === 0) break;

    d++;
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (d > dim) { d = 1; mo++; if (mo > 12) { mo = 1; y++; } }
    day++;
  }

  const reached = contacts.filter((c) => c.status === 'reached').length;
  const untouched = contacts.filter((c) => c.attempts === 0).length;
  const worked = contacts.filter((c) => c.attempts > 0);
  const avgAttempts = worked.length ? worked.reduce((s, c) => s + c.attempts, 0) / worked.length : 0;

  return {
    label, escalationRate, isaCapacity,
    calendarDays: day + 1, months: (day + 1) / 30.4,
    totalDials, peakTarget, reached, untouched, avgAttempts,
    reachPct: 100 * reached / TOTAL,
    leakedTotal: Math.round(leakedTotal),
    drained: untouched === 0, violations, trace, idleDaysWithBacklog, TOTAL,
  };
}

// ---------------------------------------------------------------------------

// Capacity 85 is MEASURED, not assumed: on 2026-07-31 the pod queued 85
// conversations and completed all 85 (contacts table, queue_date breakdown).
// Capacity 30 was an earlier estimate inferred from the "rolled N uncalled"
// log lines, which turned out to be next-day deferral rather than loss —
// 125 of 130 conversations were ultimately worked (96%).
const scenarios = [
  { label: 'A · All escalate · measured cap 85',       escalationRate: 1.00, isaCapacity: 85 },
  { label: 'B · All escalate · pessimistic cap 40',    escalationRate: 1.00, isaCapacity: 40 },
  { label: 'C · All escalate · old assumed cap 30',    escalationRate: 1.00, isaCapacity: 30 },
  { label: 'D · Qualified only · pessimistic cap 40',  escalationRate: 0.18, isaCapacity: 40 },
];

const results = scenarios.map(runScenario);

console.log('\n' + '='.repeat(82));
console.log('  SCENARIO SWEEP — what actually governs program length');
console.log('  23,563 target (Jake-held, good phone) · per-cohort answer rates · measured capacity');
console.log('='.repeat(82));
console.log('  scenario                                esc%  peak/day  months  reached  leaked');
console.log('  ' + '-'.repeat(78));
for (const r of results) {
  console.log(
    '  ' + r.label.padEnd(38) +
    String(Math.round(r.escalationRate * 100)).padStart(4) +
    String(r.peakTarget).padStart(10) +
    (r.drained ? r.months.toFixed(1) : ' 25+').padStart(8) +
    String(r.reached.toLocaleString()).padStart(9) +
    String(r.leakedTotal.toLocaleString()).padStart(8),
  );
}
console.log('='.repeat(82));

for (const r of results) {
  console.log(`\n  ${r.label}`);
  console.log(`    peak ${r.peakTarget}/day · ${r.totalDials.toLocaleString()} dials · ` +
    `avg ${r.avgAttempts.toFixed(2)} attempts · reach ${r.reachPct.toFixed(1)}% · ` +
    `${r.drained ? `drained in ${r.months.toFixed(1)} mo` : `${r.untouched.toLocaleString()} NEVER TOUCHED`}`);
  console.log(`    leaked (conversations no human called): ${r.leakedTotal.toLocaleString()}`);
}

console.log('\n  Guardrail check:');
const allClean = results.every((r) =>
  r.violations.rolling7 === 0 && r.violations.sunday === 0 && r.violations.outOfWindow === 0);
for (const r of results) {
  console.log(`    ${r.label.slice(0, 1)}: rolling7=${r.violations.rolling7} sunday=${r.violations.sunday} ` +
    `outOfWindow=${r.violations.outOfWindow} idleDaysWithBacklog=${r.idleDaysWithBacklog}`);
}

const C = results[0];
console.log(`\n  Ramp trace — Scenario A (every 30 days):`);
console.log('    day  target  pushed  connects  rollover7d  state');
for (const t of C.trace) {
  console.log(`    ${String(t.day).padStart(3)}  ${String(t.target).padStart(6)}  ` +
    `${String(t.pushed).padStart(6)}  ${String(t.connects).padStart(8)}  ` +
    `${(t.rollover * 100).toFixed(0).padStart(9)}%  ${t.state}`);
}

console.log(`\n  RESULT: ${allClean ? 'PASS — no guardrail violations in any scenario' : 'FAIL — see violations'}\n`);
process.exit(allClean ? 0 : 1);
