# Reactivation Engine

Cohort-based automation for the SimpleTalk 30k database program.
Drops into the existing `DavidTribeca/isa-call-list` service.

**Postgres is the brain. GHL is the hands. FUB stays the CRM of record.**

You keep working in Follow Up Boss exactly as you do today. You just stop being
the scheduler.

---

## Why not do this with FUB tags and automations

FUB action plans can't hold an attempt counter, can't express "retry Saturday
morning," and generally won't re-fire for someone who already completed the
plan. Encoding cohorts as tags means dozens of near-duplicate automations and no
way to answer "how many people are mid-ladder right now." So the queue state
lives in Postgres, and FUB gets written to for visibility and for the
`stop ai call` kill switch.

---

## Flow

```
Postgres re_contact          ← cohort · wave · attempt_count · next_eligible_at
        │                      consent_tier · suppression · throttle state
        │  dispatcher cron (10a Mon–Sat · 4p, 6p Mon–Fri)
        ▼
GHL API  ── upsert contact + enrol in SimpleTalk workflow  ← THE DIAL TRIGGER
        ▼
SimpleTalk dials
        │
    ┌───┴────────────────────┐
    ▼                        ▼
GHL webhook            SimpleTalk ingest
(real-time opt-outs)   (already built)
    └───┬────────────────────┘
        ▼
re_attempt logged · state advanced · FUB tagged `stop ai call` when reached
```

---

## Files

| Path | Role |
|---|---|
| `migrations/001_reactivation_engine.sql` | Schema. All tables prefixed `re_` so nothing existing collides. |
| `src/reactivation/db.js` | Pool factory + `programDate()`. Defines the program day as the Pacific day, on both the JS and the Postgres side. |
| `src/reactivation/schedule.js` | When the dispatcher runs, as data. The suite checks these slots against the dial windows. |
| `src/reactivation/ladder.js` | When the next attempt happens. Rotating windows, DST-safe, no Sundays. |
| `src/reactivation/throttle.js` | How many dials to release. Trailing 7-day counts with minimum-sample guards. |
| `src/reactivation/dispatcher.js` | The daily engine: select, push, record outcome, advance state. |
| `src/reactivation/adapters/ghl.js` | Pushes contacts into SimpleTalk. **Verify endpoints before first run.** |
| `src/reactivation/adapters/fub.js` | Tag writes. Read-merge-write so team tags are never wiped. |
| `src/reactivation/adapters/isa-list.js` | Measures rollover from the ISA queue — the throttle's capacity signal. |
| `src/reactivation/webhook.js` | GHL webhook → real-time opt-out suppression. |
| `src/reactivation/reconcile.js` | Second, independent outcome path off the SimpleTalk ingest. Stops a missed webhook becoming a repeat call. |
| `src/reactivation/migrate.js` | Applies migrations on boot. Fatal on failure. |
| `scripts/preflight.js` | "Can this go live, and if not, why not" — one read-only command. |
| `scripts/import-from-fub.js` | One-time import + cohort/consent tiering. Run `--dry-run` first. |
| `scripts/run-dispatch.js` | Cron entry point. |
| `scripts/simulate.js` | Scenario sweep. No DB, no API calls. |

---

## Setup

**1. Migrations run themselves.**

The service applies every file in `migrations/` on boot, records what it
applied in `re_migration`, and exits rather than serving on a half-applied
schema. Deploying is migrating; there is no psql step and nothing to remember.

To apply them without starting the server:

```bash
npm run reactivate:migrate
```

**Dialing is OFF on a fresh install.** `re_dialing_enabled()` returns false
until someone runs `run-dispatch.js resume`, which records who turned it on and
when. Deploying and deciding to start calling people are different decisions,
and on this program they are days apart.

**2. Add environment variables** (alongside the ones you already have):

```
GHL_SIMPLETALK_WORKFLOW_ID=   # the GHL workflow SimpleTalk dials from
RE_ALLOWED_CONSENT_TIERS=written,ebr_current,ebr_expired,unknown
RE_DNC_POND_NAME=Do Not Contact
RE_DNC_STAGES=Trash,Do Not Contact,Bad Number
RE_SUPPRESSION_MAX_AGE_MIN=120
RE_STALE_INFLIGHT_HOURS=20
RE_MAX_IN_FLIGHT=0            # 0 = auto (60% of daily target)
RE_MAX_PER_RUN=400
RE_ALERT_WEBHOOK=             # Slack/Discord/Zapier/GHL inbound hook — set this
RE_ALERT_ON_WARNING=false
DAILY_CAP=100                 # starting target; the throttle takes over

# WAVE 0 LAUNCH LOCKS — set for the first live day, clear to open up.
RE_ONLY_COHORTS=hot_engaged    # empty = every cohort
RE_ONLY_WINDOWS=mid_morning    # empty = every window
```

The launch locks are the difference between a plan that says "one cohort,
mid-morning only" and a system that enforces it. Empty means unrestricted, so
opening the program up later is a variable change in Railway, not a deploy.

`RE_ALLOWED_CONSENT_TIERS` is open to all tiers per counsel's 6 Aug decision:
everything is dialable **except** what's in the FUB do-not-contact pond. That
makes the pond sync safety-critical rather than a nice-to-have — see below.

`RE_DNC_POND_NAME` must match the FUB pond name exactly.

**3. Seed the caller-ID pool.** At 750 dials/day you need 8–10 numbers, each
under ~110/day, or carriers will flag them.

```sql
INSERT INTO re_caller_number (phone_e164, label, daily_cap) VALUES
  ('+1206...', 'seattle-1', 110),
  ('+1425...', 'eastside-1', 110);
```

**4. Dry-run the import.** Tune the stage names and consent sources at the top
of `import-from-fub.js` first, then:

```bash
node scripts/import-from-fub.js --dry-run
```

This prints the real cohort and consent-tier distribution. **That output is what
replaces the placeholder estimates in the plan document** — the "BY CONSENT
TIER" block is your actual bot-eligible universe.

**4b. Check you are actually ready.**

```bash
npm run reactivate:preflight
```

Read-only, places no calls, safe against a live program. It checks the schema,
that Postgres and the app agree on what day it is, contacts loaded, suppression
freshness, the caller pool, the GHL token and workflow id, the reconciler's link
column, and the alert webhook — and prints a specific fix for anything failing.
Exits non-zero if anything is a blocker, so it can gate a deploy.

**5. Verify the GHL adapter against one test contact** before enabling cron.
The two endpoint shapes in `adapters/ghl.js` could not be verified from the
session that wrote them.

**6. Dry-run the dispatcher.**

```bash
node scripts/run-dispatch.js dispatch --dry-run
```

**7. Enable cron** (America/Los_Angeles):

```
*/15 *    * * *    node scripts/sync-suppression.js         # suppression — must be fresh or dialing halts
0    10   * * 1-6  node scripts/run-dispatch.js dispatch    # mid-morning  (45% of daily target)
0    16   * * 1-5  node scripts/run-dispatch.js dispatch    # late afternoon (to 75%)
0    18   * * 1-5  node scripts/run-dispatch.js dispatch    # evening, weekdays (to 100%)
45   20   * * *    node scripts/run-dispatch.js reconcile   # outcomes from the SimpleTalk ingest
0    21   * * *    node scripts/run-dispatch.js reap        # rescue stuck in-flight
30   21   * * *    node scripts/run-dispatch.js rollup      # metrics the throttle reads tomorrow
15   3    * * *    node scripts/sync-suppression.js --full  # nightly reconciliation
0    8,13,20 * * * node scripts/health-check.js             # ALERTS — see below
```

**Eight cron entries and no daily human step.** Once these are running the program selects, dials, retries, suppresses, tags, throttles, and advances waves on its own.

The health check is what makes that claim honest. Every safety mechanism here fails *closed* — a stale suppression sync halts dialing, an in-flight ceiling pauses intake, a red throttle halves volume. Correct behaviour, but it means the program can stop safely and **silently**. The health check runs three times a day, decides whether a human is needed, and posts to `RE_ALERT_WEBHOOK` (Slack, Discord, Zapier, or a GHL inbound hook). It also exits non-zero on CRITICAL so Railway's own cron alerting fires independently — two ways to hear about it.

What it pages you for: suppression stale (dialing halted), no dials pushed on a working day, GHL push failures above 20%, contacts in flight with zero outcomes coming back (the bot may be re-calling people who already answered), throttle red three days running, caller numbers flagged or too few, and opt-outs above 2%.


The suppression sync is listed first deliberately. If it hasn't succeeded
within `RE_SUPPRESSION_MAX_AGE_MIN`, **the dispatcher aborts and dials nobody** —
verified by integration test. A stale sync means a stale view of who has opted
out, and the safe failure mode is not calling anyone.

**8. Mount the webhook** and point GHL at it:

```js
import { ghlWebhookRouter } from './src/reactivation/webhook.js';
app.use('/webhooks/ghl', ghlWebhookRouter(db));
```

---

## Rollover — measured, not logged

The throttle's most important signal is the share of escalated conversations no
human gets to. It is now measured directly from the `contacts` table the
isa-call-list service already writes: escalated more than 48 hours ago and still
carrying a null `completed_at`. See `adapters/isa-list.js`.

It deliberately does **not** read the `[scheduler] rolled N uncalled contact(s)`
log lines. Those record a contact being *deferred to the next day*, and the 6
August query showed 96% of deferred conversations are eventually worked, at a
median of 6.1 hours. Counting deferrals as losses reads ~20–50% rollover against
a 15% red line, which would pin volume at the floor permanently.

If the `contacts` table is missing, or there are fewer than 10 escalations past
the grace period, the measurement returns null and the throttle reports
"insufficient data" for that signal rather than acting on a wrong one.

**The escalation filter** is the one thing still left to you. It is the single
highest-leverage change in the whole program — see below.

---

## The escalation filter

The scenario sweep in `scripts/simulate.js`, calibrated to your Aug 2 logs:

| Scenario | Escalation rate | Peak/day | Months to drain | Leaked |
|---|---|---|---|---|
| A — every conversation escalates *(today)* | 100% | 750 | **20.2** | 635 |
| B — right-party only | 35% | 750 | **6.4** | 124 |
| C — qualified only | 18% | 750 | **6.4** | 0 |
| D — qualified only + 3rd ISA | 18% | 750 | **6.4** | 0 |

Same 1–2 ISAs, same 88,683 dials in every row. The only variable is what share
of bot conversations become an ISA task.

Today every SimpleTalk conversation lands on the call list — Scenario A — and
the throttle correctly keeps cutting volume to protect the pod, stretching the
program to 20 months. **Filtering to right-party-only is a 3x speedup and costs
nothing but script work.** Note row D: a third ISA buys nothing once the filter
is in place.

So: SimpleTalk should only create an ISA task on a real signal — a timeline, a
motivation, a value question, an appointment request. Wrong number, immediate
hang-up, "not interested," voicemail, and gatekeeper-only contacts get logged
and dropped, never queued.

---

## Monitoring

```bash
node scripts/run-dispatch.js status
```

Three views ship with the migration:

- `re_v_cohort_status` — live funnel by cohort and wave
- `re_v_window_performance` — answer rate by attempt number and time window;
  this is how you confirm the rotating ladder is actually beating same-time retries
- `re_v_number_health` — per-number answer rate vs pool median, with a
  `RETIRE` recommendation when a number falls 30% below

---

## Design notes worth knowing

**Waves self-refill.** The batch query in `runDispatch` is deliberately *not*
scoped to one wave. It orders by `wave ASC, priority_score DESC`, so when Wave 1
drains it automatically pulls from Wave 2 to hit the daily target. Nobody has to
notice a wave finished. Simulation confirms zero idle days while a callable
backlog exists.

**Why the throttle uses counts, not rates.** An earlier version evaluated
single-day rates. At ~10 connects/day, one opt-out reads as a 10% opt-out rate
and slams the program to red — volume pinned at the floor forever and 3,348
contacts never touched. All signals are now trailing 7-day counts, and each is
ignored until its denominator clears a minimum sample size.

**Retries: staged handover.** SimpleTalk currently owns the next-day redial.
Leave that alone for the first month. Once the cohort engine is proven, set
SimpleTalk to single-attempt and let the dispatcher re-inject on the rotating
ladder — because the dispatcher controls *when* it pushes to GHL, you get
time-of-day rotation for free. That change is worth roughly 2,000 extra people
reached across the program on identical spend.

**Failed pushes don't consume an attempt.** A transient GHL error backs the
contact off two hours and leaves `attempt_count` untouched.

**Stale in_flight rows get reaped.** A missed webhook would otherwise park
someone forever. `reap` treats anything in flight beyond
`RE_STALE_INFLIGHT_HOURS` as a no-answer and reschedules it.

**Suppression is checked on every push, without exception.** Opt-outs land
there synchronously from the webhook, so a revocation takes effect on the very
next batch rather than at the next nightly sync.

---

## Verification

```bash
node scripts/simulate.js
```

Runs four scenarios against the real `ladder.js` and `throttle.js`. Current
result: **PASS** — no Sunday dials, no out-of-hours dials, no contact exceeding
3 attempts per 7 days, no idle days with backlog. Confirms the plan's core
assumptions: 3.99 average attempts per contact (plan assumed 4.00), 44.5%
cumulative reach (44%), 88,683 total dials (88,800).

---

## Not legal advice

`RE_ALLOWED_CONSENT_TIERS` defaults to `written` for a reason. The FCC treats
AI-generated voices as "artificial" under the TCPA, which points to a prior
express *written* consent standard that an established business relationship
does not satisfy. EBR windows (~18 months from a transaction, ~3 months from an
inquiry) also mean the dormant cohorts carry *more* risk than the fresh ones,
not less. Washington's RCW 80.36.400 adds state-level exposure. Verify all of
this with counsel before widening the gate.
