# Launch Checklist — SimpleTalk Reactivation Program
### Tribeca NW · as of 6 August 2026

Legal is cleared: **everything is dialable except what's in the FUB "do not contact" pond.** That decision removes the biggest blocker and changes one thing structurally — the pond sync is now safety-critical infrastructure rather than a hygiene task, because it's the only thing standing between the bot and someone who asked not to be called. The engine has been rebuilt around that: incremental sync every 15 minutes plus a nightly full reconciliation, append-only suppression, a sanity guard that refuses an implausibly large suppression result, and **a dispatcher that refuses to dial at all if the sync goes stale.**

What's left splits into four things you have to hand me, work I do once I have them, fixes to your existing service, and the go-live sequence.

---

## 1. Blocked on you

Nothing downstream moves until these land. Roughly fifteen minutes of your time, plus the phone-number lead time.

~~**FUB API key.**~~ **DONE 6 Aug.** Full scan completed: 31,415 people, 29,421 unique phones, verified cohort sizes and suppression populations now in the plan. The temporary key should be deleted.

**GHL API token.** You picked GHL as the source for the real answer rate. It's already in Railway as `GHL_API_TOKEN` but the connector returns values redacted, so I can't read it — paste it and I'll query dial totals and re-run every projection against measured data.

**GHL workflow ID.** The specific workflow SimpleTalk dials from. In GHL, open that workflow and take the ID from the URL. This is the actuator — without it the dispatcher has nothing to push into.

~~**Exact FUB pond name.**~~ **DONE.** Verified: pond id **4** ("Do Not Contact", 988 people). Also found pond id **50** ("Zillow Nurture Team *claimed Leads*(DO NOT PROSPECT)", 118 people) — both now hard-coded as `RE_DNC_POND_IDS=4,50`.

**Decision needed: the `Fish (Engage Raiya)` stage — 4,228 people.** If Raiya is an AI ISA already working that segment, SimpleTalk must not call them too. Tell me include or exclude; excluding shortens the program by about a month.

**Decision needed: ~2,900 records of questionable provenance.** Sources `IMPORT` (1,414), `UNKNOWN` (1,389) and `REVERSELOOKUPSLS` (125) aren't inbound leads — reverse-lookup in particular means appended data, not a number someone gave you. Worth confirming counsel's clearance covered these, since they aren't a prior business relationship in the sense that clearance likely assumed.

**Also start now (lead time):** provision **8–10 local-presence numbers**, register them with the Free Caller Registry, and confirm STIR/SHAKEN attestation with SimpleTalk. At 750 dials/day a single number gets flagged within days, and once flagged it's permanently burned.

---

## 2. What I do once I have those

In this order, because each feeds the next:

Query GHL for real dial totals and compute your actual answer rate, then re-run the projections — this collapses the largest error bar in the plan, since everything currently keys off modelled per-cohort rates averaging 8.6%. Run the suppression sync once manually and confirm it lands near the expected ~2,100. Verify the two unverified GHL endpoint shapes against a single test contact. Capture a few real GHL webhook payloads and map the event names, since my `mapOutcome` patterns are educated guesses. Then apply both migrations to production Postgres, seed the caller-number pool, and wire the rollover feed into `nightlyRollup`.

---

## 3. Fixes to the existing isa-call-list service

Three items surfaced from querying your live data, all small and all worth doing before volume goes up.

**Populate `email` on ingest.** All 130 rows have it blank, which throws away your only fallback channel for the ~7% of records with no working phone.

**Fix the `completed_at` / `bot_call_at` ordering.** Some rows show completion up to 65 hours *before* the bot call. Either ISAs are calling first or a timestamp is written wrong — don't build latency reporting on those columns until it's resolved.

**Investigate the 3 records with no FUB match.** Those conversations happened and reached nobody's pipeline.

**Leave SimpleTalk's next-day retry ON for the first month.** Prove the cohort engine first. Once it's stable, switch SimpleTalk to single-attempt and let the dispatcher own retries on the rotating ladder — worth roughly 2,000 additional people reached on identical spend, but not worth compounding two changes at once.

---

## 4. Process — you and the team

**ISA follow-up SLA.** Suggested: first attempt within 2 business hours of the bot conversation, three attempts within 48 hours. Your measured median is already 6.1 hours, so this is codifying something close to current behaviour rather than asking for a change.

**Live-transfer escalation path.** Define what happens when the bot has someone live and no ISA is free. An abandoned transfer is the single worst outcome in the funnel — worse than never calling.

**Monday throttle review.** Ten minutes against `run-dispatch.js status`. Green means step volume up 25%, yellow means hold, red means cut in half. The rule is already coded; the ritual is what makes it real.

**Escalation filter — second priority now.** Verified data moved this back up: it's worth about a month outright (8.0 → 7.1), and thirteen months if sustained capacity turns out nearer 40/day than the 85 you demonstrated on Jul 31. Still not a launch blocker, but do it early.

---

## 5. Go-live sequence

| Day | Action | Gate before proceeding |
|---|---|---|
| **1** | Apply migrations 001 + 002. Import from FUB. Run pond sync. **No dialing.** | Cohort counts look sane; suppression count matches expectation |
| **2** | `dispatch --dry-run`. Inspect exactly who would be called and in what order. | You personally recognise the names at the top of the list |
| **3** | Enable hourly suppression sync. Verify the freshness gate blocks a live dispatch when you deliberately stale it. | Gate confirmed working |
| **4** | First live dial. **100/day, top-engagement cohort only, mid-morning window only.** | Zero out-of-window dials; opt-outs land in suppression within the hour |
| **5–14** | Calibration. Measure answer rate, right-party rate, qualification rate, appointment rate. A/B two script openings. | Five consecutive green days |
| **15** | First Monday throttle review. Begin the ramp: 100 → 125 → 156 → 195… | Rollover under 5% |
| **~Week 8** | Reach 750/day steady state | — |
| **~Month 8** | Database worked through | — |

The Day 4 constraint matters more than it looks. One cohort, one window, 100 dials — that's a deliberately small blast radius for the first live batch, because that's when integration bugs surface, and you want them surfacing against 100 records rather than 750.

---

## 6. Residual risks, stated plainly

**The FUB pond is not a registry scrub.** It's a list of people who told *you* to stop. Counsel cleared you to operate that way and the engine is built to it — but the two aren't equivalent and carry different exposure. Worth revisiting if volume or complaint rate climbs.

**Two GHL endpoints are unverified.** I couldn't reach GHL's docs. If `POST /contacts/upsert` or the workflow-enrolment path differs, `adapters/ghl.js` is the only file that changes — but that's exactly why Day 2's dry run and Day 4's 100-record batch exist.

**Answer rate is still modelled, not measured.** Per-cohort rates of 15/13/10/7% by age drive every projection in §8. They're reasoned estimates, not your data. The GHL query fixes this before launch; Wave 0 fixes it regardless.

**Sustained ISA capacity is unknown.** 85/day is a demonstrated single-day peak, not a proven daily rate. If the real number is nearer 40, the timeline stretches to 20.4 months without the escalation filter. The Monday throttle review catches this within two weeks either way.

---

## Verified state of the engine

Migrations 001 and 002 apply cleanly to Postgres 16 and are idempotent. **25 integration tests pass** against live Postgres, including the consent gate, suppression exclusion, wave ordering, the full attempt-ladder state machine, ladder exhaustion, the stale-in-flight reaper, and the suppression freshness gate in all three states. The scenario simulation passes with zero guardrail violations — no Sunday dials, no dials outside 8am–8pm local, no contact exceeding three attempts in a rolling seven days.

Not legal advice.
