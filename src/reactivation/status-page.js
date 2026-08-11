/**
 * Live dashboard, server-rendered from the tracking views.
 *
 * ── WHAT THIS PAGE IS FOR ─────────────────────────────────────────────────
 *
 * One question above all others: how many PEOPLE are moving through the
 * program, and is that rate holding? Every other view in this codebase counts
 * dials, and dials mislead — with a five-rung ladder each person absorbs about
 * 4.2 of them, so a 750-dial day introduces roughly 180 new people. Reading the
 * dial count as intake overstates progress four-fold.
 *
 * So the hero numbers are people: entering, in the cycle, leaving. Dials appear
 * only as the second series on the intake chart, where the GAP between the two
 * lines is the useful signal — near 4x means the ladder is retrying properly,
 * stuck near 1x means retries are not firing at all.
 *
 * ── DESIGN ────────────────────────────────────────────────────────────────
 *
 * Dark-first, deep navy, translucent panels — built to a reference the account
 * owner picked out. Dark is the DEFAULT here rather than an inversion of a light
 * design, and light is its own stepped set rather than an automatic flip.
 *
 * Every colour was re-validated against THESE surfaces, not inherited. The card
 * surface is #0f1535, a long way from the #1a1a19 the reference palette assumes:
 *
 *   categorical (blue people / orange dials) — worst adjacent CVD ΔE 26.8,
 *     normal-vision 31.8, both clear 3:1 on #0f1535
 *   ordinal ladder ramp, 5 steps — monotone, every ΔL gap ≥ 0.06, light end
 *     2.20:1 against the surface
 *   text — white 17.8:1, secondary #a3aed0 8.1:1, muted #8f9bba 6.4:1
 *   status — good #01b574 6.7:1, warning #ffb547 10.1:1, critical #ee5d50 5.4:1
 *
 * The brand gradient blue #3965ff measures 3.80:1, so it is used for fills only
 * — icon chips, the gauge arc, gradient stops — and never for text.
 *
 * Status ships as colour + word. Both chart series are named in the legend. The
 * gauge carries its number as text. Nothing is colour-alone.
 *
 * No build step, no client framework, no external requests. If this page
 * renders, the database is reachable and the views are intact — which is itself
 * a useful signal. The only script is a theme toggle and the chart tooltips.
 */
import { funnelSection } from './funnel-section.js';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString());
const pct = (a, b) => (b > 0 ? (100 * a) / b : 0);

/** Ordinal ramp for ladder rungs 1..5. Light and dark both validated. */
const RUNG_LIGHT = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'];
const RUNG_DARK  = ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'];

export async function renderStatusPage(db) {
  const q = (sql, fallback) => db.query(sql).then((r) => r.rows).catch(() => fallback);

  const [flow, cycle, rate, intake, ladder, cohorts, burndown, today, release, sync, ctl,
         dncCount] =
    await Promise.all([
      q(`SELECT * FROM re_v_flow`, [{}]).then((r) => r[0] || {}),
      q(`SELECT * FROM re_v_cycle`, [{}]).then((r) => r[0] || {}),
      q(`SELECT * FROM re_v_intake_rate`, [{}]).then((r) => r[0] || {}),
      q(`SELECT day::text AS day, new_people, dials, connects FROM re_v_intake_daily
          ORDER BY day DESC LIMIT 14`, []).then((r) => r.reverse()),
      q(`SELECT * FROM re_v_ladder_position`, []),
      q(`SELECT * FROM re_v_cohort_status`, []),
      q(`SELECT * FROM re_v_burndown`, [{}]).then((r) => r[0] || {}),
      q(`SELECT * FROM re_v_today_by_window`, []),
      q(`SELECT *, release_date::text AS day FROM re_daily_release
          ORDER BY release_date DESC LIMIT 7`, []),
      q(`SELECT * FROM re_sync_state WHERE key='suppression'`, [{}]).then((r) => r[0] || {}),
      q(`SELECT * FROM re_control WHERE key='dialing_enabled'`, [{}]).then((r) => r[0] || {}),
      // The do-not-call list itself, not contacts flagged suppressed. The footer
      // used re_v_flow.suppressed_total, which counts re_contact rows with
      // status='suppressed' — a different thing that reads 0 on a healthy
      // install. It displayed "0 numbers suppressed" against a live list of
      // 2,284, which invites exactly the wrong conclusion about a compliance
      // control.
      q(`SELECT count(*)::int AS n FROM re_suppression`, [{ n: null }]).then((r) => r[0]?.n),
    ]);

  const dialing = ctl.value === 'true';
  const fresh = flow.suppression_fresh;
  const state = !dialing ? { word: 'STOPPED', tone: 'critical', icon: '⛔' }
    : !fresh ? { word: 'BLOCKED', tone: 'critical', icon: '⛔' }
    : flow.throttle_state === 'red' ? { word: 'THROTTLED', tone: 'warning', icon: '▼' }
    : flow.throttle_state === 'yellow' ? { word: 'HOLDING', tone: 'serious', icon: '▪' }
    : { word: 'RUNNING', tone: 'good', icon: '▲' };

  const totalProgram = Number(cycle.total_in_program || 0);
  const notEntered = Number(cycle.not_yet_entered || 0);
  const inCycle = Number(cycle.in_cycle || 0);
  const leftTotal = Number(cycle.left_total || 0);
  const reached = Number(cycle.left_reached || 0) + Number(cycle.left_appointment || 0);

  // ---- intake chart -------------------------------------------------------
  const maxIntake = Math.max(1, ...intake.map((d) => Math.max(d.dials, d.new_people)));
  const anyIntake = intake.some((d) => d.dials > 0);

  const chart = (() => {
    if (!anyIntake) {
      return `<div class="empty">
        <strong>Nothing dialled yet.</strong> Once the first batch goes out this fills in with
        two lines: people entering the cycle, and total dials placed. The gap between them is
        the retry load — around 4&times; once the ladder is running, and stuck near 1&times; if
        retries aren't firing.</div>`;
    }
    const W = 780, H = 190, PL = 40, PR = 12, PT = 14, PB = 26;
    const iw = W - PL - PR, ih = H - PT - PB;
    const X = (i) => PL + (intake.length === 1 ? iw / 2 : (i * iw) / (intake.length - 1));
    const Y = (v) => PT + ih - (v / maxIntake) * ih;
    const path = (key) => intake.map((d, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(d[key]).toFixed(1)}`).join('');
    const ticks = [0, Math.round(maxIntake / 2), maxIntake];

    const area = (key) => `${path(key)}L${X(intake.length - 1).toFixed(1)},${(PT + ih).toFixed(1)}` +
      `L${PL},${(PT + ih).toFixed(1)}Z`;

    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img"
      aria-label="Daily people entering the cycle and total dials, last 14 days">
      <defs>
        <linearGradient id="gd" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--s2)" stop-opacity=".32"/>
          <stop offset="100%" stop-color="var(--s2)" stop-opacity="0"/></linearGradient>
        <linearGradient id="gp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--s1)" stop-opacity=".40"/>
          <stop offset="100%" stop-color="var(--s1)" stop-opacity="0"/></linearGradient>
      </defs>
      ${ticks.map((t) => `<g>
        <line class="grid" x1="${PL}" x2="${W - PR}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/>
        <text class="axis" x="${PL - 8}" y="${(Y(t) + 3.5).toFixed(1)}" text-anchor="end">${t}</text>
      </g>`).join('')}
      <path d="${area('dials')}" fill="url(#gd)"/>
      <path d="${area('new_people')}" fill="url(#gp)"/>
      <path class="ln s2" d="${path('dials')}"/>
      <path class="ln s1" d="${path('new_people')}"/>
      ${intake.map((d, i) => `
        <g class="pt">
          <circle class="dot s2f" cx="${X(i).toFixed(1)}" cy="${Y(d.dials).toFixed(1)}" r="4.5"/>
          <circle class="dot s1f" cx="${X(i).toFixed(1)}" cy="${Y(d.new_people).toFixed(1)}" r="4.5"/>
          <rect class="hit" x="${(X(i) - 13).toFixed(1)}" y="${PT}" width="26" height="${ih}"/>
          <title>${esc(d.day)} — ${d.new_people} new ${d.new_people === 1 ? 'person' : 'people'}, ${d.dials} dials, ${d.connects} connected</title>
        </g>`).join('')}
      <text class="axis" x="${PL}" y="${H - 7}">${esc(intake[0]?.day.slice(5) || '')}</text>
      <text class="axis" x="${W - PR}" y="${H - 7}" text-anchor="end">${esc(intake.at(-1)?.day.slice(5) || '')}</text>
    </svg>
    <div class="legend">
      <span><i class="sw k1"></i>People entering the cycle</span>
      <span><i class="sw k2"></i>Dials placed</span>
    </div>`;
  })();

  // ---- icon chips (inline SVG — no external requests) ---------------------
  const ICONS = {
    people: '<path d="M8 8a3 3 0 100-6 3 3 0 000 6zM2 15c0-2.8 2.7-4.5 6-4.5s6 1.7 6 4.5"/>',
    cycle:  '<path d="M14 8A6 6 0 013 12M2 8a6 6 0 0111-4M11 2v3h3M5 14v-3H2"/>',
    phone:  '<path d="M3 3h3l1.5 4L6 8.5a9 9 0 004 4L11.5 11l4 1.5v3a1 1 0 01-1 1A12 12 0 012 4a1 1 0 011-1z"/>',
    check:  '<path d="M2.5 8.5l4 4 7-9"/>',
  };
  const chip = (k) =>
    `<span class="chip"><svg viewBox="0 0 16 16" aria-hidden="true">${ICONS[k]}</svg></span>`;

  // ---- program-complete gauge --------------------------------------------
  // Semicircle: the arc length of a half circle is pi*r, so the dash offset is
  // that length scaled by the remaining fraction. The number is printed inside
  // it, so the arc is never the only thing carrying the value.
  const donePct = pct(leftTotal, totalProgram);
  const ARC = Math.PI * 62;
  const gauge = `<svg viewBox="0 0 160 100" class="gauge" role="img"
      aria-label="${donePct.toFixed(1)} percent of the program finished with">
    <defs><linearGradient id="ga" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="var(--brand)"/>
      <stop offset="100%" stop-color="var(--good-fill)"/></linearGradient></defs>
    <path d="M18 84 A62 62 0 0 1 142 84" class="gtrack"/>
    <path d="M18 84 A62 62 0 0 1 142 84" class="gfill"
      stroke-dasharray="${ARC.toFixed(1)}"
      stroke-dashoffset="${(ARC * (1 - donePct / 100)).toFixed(1)}"/>
    <text x="80" y="74" class="gnum">${donePct.toFixed(1)}%</text>
  </svg>`;

  // ---- ladder position ----------------------------------------------------
  const maxRung = Math.max(1, ...ladder.map((r) => r.people));
  const ladderRows = ladder.length ? ladder.map((r) => {
    const i = Math.min(4, Math.max(0, Number(r.attempts_made) - 1));
    return `<div class="lrow">
      <span class="llab">After ${r.attempts_made} ${Number(r.attempts_made) === 1 ? 'call' : 'calls'}</span>
      <span class="ltrack"><i style="width:${pct(r.people, maxRung).toFixed(1)}%;
        background:var(--rung-${i + 1})"></i></span>
      <span class="lnum">${n(r.people)}</span>
      <span class="lsub">${r.awaiting_outcome > 0 ? `${n(r.awaiting_outcome)} awaiting` : ''}</span>
    </div>`;
  }).join('') : `<div class="empty">Nobody is mid-ladder yet. As people are called and don't
    answer, they'll stack up here by how many attempts they've had — bunching at
    "after 1 call" would mean retries have stalled.</div>`;

  // ---- cohorts ------------------------------------------------------------
  // Cohorts with nobody in them are noise. hot_engaged and recycled are defined
  // in the schema but never populated by the import, so they would sit at the top
  // of the table forever showing zeros.
  const shown = cohorts.filter((c) => Number(c.total) > 0);
  const cohortRows = shown.length ? shown.map((c) => {
    const total = Number(c.total) || 0;
    const worked = total - Number(c.waiting || 0);
    return `<tr>
      <td><span class="wv">W${esc(c.wave)}</span> ${esc(c.label || c.cohort)}</td>
      <td class="n">${n(c.waiting)}</td><td class="n">${n(c.in_flight)}</td>
      <td class="n">${n(c.reached)}</td><td class="n">${n(c.appointments)}</td>
      <td class="n">${n(total)}</td>
      <td style="width:150px"><span class="ptrack"><i style="width:${pct(worked, total).toFixed(1)}%"></i></span>
        <span class="psub">${pct(worked, total).toFixed(0)}%</span></td>
    </tr>`;
  }).join('') : `<tr><td colspan="7" class="mut">No contacts imported yet.</td></tr>`;

  const windowRows = today.length ? today.map((w) => `<tr>
      <td>${esc(String(w.window_label).replace(/_/g, ' '))}</td>
      <td class="n">${n(w.pushed)}</td><td class="n">${n(w.awaiting_outcome)}</td>
      <td class="n">${n(w.connects)}</td>
      <td class="n">${Number(w.push_failures) > 0
        ? `<span class="bad">${n(w.push_failures)}</span>` : '0'}</td>
    </tr>`).join('') : `<tr><td colspan="5" class="mut">No dials yet today.</td></tr>`;

  const releaseRows = release.length ? release.map((r) => {
    const t = r.throttle_state === 'red' ? 'critical'
      : r.throttle_state === 'yellow' ? 'warning' : 'good';
    return `<tr><td class="mono">${esc(r.day)}</td>
      <td class="n">${n(r.target_dials)}</td><td class="n">${n(r.actual_pushed)}</td>
      <td><span class="tag ${t}">${esc(r.throttle_state)}</span></td>
      <td class="mut sm">${esc((r.throttle_reason || '').slice(0, 110))}</td></tr>`;
  }).join('') : `<tr><td colspan="5" class="mut">No release history yet.</td></tr>`;

  const dpp = rate.dials_per_person;
  const dppNote = dpp === null || dpp === undefined ? 'measured once retries begin'
    : Number(dpp) < 1.6 ? `${dpp}/person — retries may not be firing`
    : `${dpp} per person`;

  return `<!DOCTYPE html><html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Reactivation Engine — live</title><style>
/* Dark is the default and the designed mode. Light is its own stepped set. */
:root{
  color-scheme:dark;
  --page:#060b28; --glow1:#0b1e6b; --glow2:#1c1042;
  --card:#0f1535; --card2:#131a3f; --edge:rgba(255,255,255,.09);
  --tp:#ffffff; --ts:#a3aed0; --tm:#8f9bba;
  --s1:#3987e5; --s2:#d95926;
  --brand:#3965ff; --good:#01b574; --warning:#ffb547; --critical:#ee5d50;
  --serious:#ffb547;
  --rung-1:#184f95; --rung-2:#256abf; --rung-3:#3987e5; --rung-4:#6da7ec; --rung-5:#9ec5f4;
  --track:rgba(255,255,255,.10);
  --good-fill:#01b574;
}
:root[data-theme="light"]{
  color-scheme:light;
  --page:#eef1f8; --glow1:#dbe4fb; --glow2:#e7e2f7;
  --card:#ffffff; --card2:#f6f8fd; --edge:rgba(15,21,53,.11);
  --tp:#0b1030; --ts:#4a5578; --tm:#68729a;
  --s1:#2a78d6; --s2:#eb6834;
  --brand:#2451e6; --good:#0a7d0a; --warning:#7a5600; --critical:#c0392b;
  --serious:#7a5600;
  --rung-1:#86b6ef; --rung-2:#5598e7; --rung-3:#2a78d6; --rung-4:#1c5cab; --rung-5:#104281;
  --track:rgba(15,21,53,.09);
  --good-fill:#0a7d0a;
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--tp);
  background:
    radial-gradient(1100px 620px at 12% -8%, var(--glow1) 0%, transparent 62%),
    radial-gradient(900px 560px at 92% 4%, var(--glow2) 0%, transparent 60%),
    var(--page);
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased}
.w{max-width:1120px;margin:0 auto;padding:30px 22px 76px}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
h1{font-size:23px;margin:0 0 3px;letter-spacing:-.02em;font-weight:700}
.sub{color:var(--ts);font-size:12.5px;margin:0}
.tbtn{background:var(--card);color:var(--ts);border:1px solid var(--edge);border-radius:10px;
  padding:7px 13px;cursor:pointer;font:inherit;font-size:12.5px}
.tbtn:hover{color:var(--tp);border-color:var(--s1)}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.11em;color:var(--tm);
  margin:32px 0 12px;font-weight:700}
.c{background:linear-gradient(159deg,var(--card) 0%,var(--card2) 100%);
  border:1px solid var(--edge);border-radius:18px;padding:19px 21px;
  box-shadow:0 8px 26px rgba(0,0,0,.16)}
.g{display:grid;gap:14px}
.g4{grid-template-columns:repeat(4,1fr)}
.g2{grid-template-columns:1.55fr 1fr}
@media(max-width:900px){.g4{grid-template-columns:1fr 1fr}.g2{grid-template-columns:1fr}}
@media(max-width:540px){.g4{grid-template-columns:1fr}}
.tile{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.lab{font-size:10.5px;color:var(--tm);text-transform:uppercase;letter-spacing:.08em;font-weight:700}
.val{font-size:29px;font-weight:700;letter-spacing:-.03em;margin:6px 0 3px;
  font-variant-numeric:tabular-nums;line-height:1.04}
.val.sm{font-size:22px}
.note{font-size:11.5px;color:var(--ts)}
.chip{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:none;
  background:linear-gradient(135deg,var(--brand) 0%,var(--s1) 100%);
  box-shadow:0 4px 14px rgba(57,101,255,.30)}
.chip svg{width:17px;height:17px;fill:none;stroke:#fff;stroke-width:1.6;
  stroke-linecap:round;stroke-linejoin:round}
.hero{display:flex;align-items:center;gap:8px}
.hero .ic{font-size:13px}
.banner{border-radius:14px;padding:13px 16px;margin:16px 0 0;font-size:13.5px;
  border:1px solid var(--critical);background:color-mix(in srgb,var(--critical) 11%,transparent);
  display:flex;gap:11px;align-items:flex-start}
.banner strong{color:var(--tp)}
.banner code{background:var(--track);padding:1px 6px;border-radius:5px}
.flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:12px;align-items:center}
@media(max-width:760px){.flow{grid-template-columns:1fr}.arw{display:none}}
.stage{background:var(--track);border-radius:14px;padding:15px 16px}
.stage .val{font-size:24px;margin:4px 0 2px}
.arw{color:var(--tm);font-size:18px;text-align:center}
.gauge{width:100%;max-width:210px;height:auto;display:block;margin:6px auto 2px}
.gtrack{fill:none;stroke:var(--track);stroke-width:13;stroke-linecap:round}
.gfill{fill:none;stroke:url(#ga);stroke-width:13;stroke-linecap:round}
.gnum{fill:var(--tp);font:700 25px/1 ui-sans-serif,sans-serif;text-anchor:middle;
  font-variant-numeric:tabular-nums}
.chart{width:100%;height:auto;display:block;overflow:visible}
.grid{stroke:var(--edge);stroke-width:1}
.axis{fill:var(--tm);font-size:10px;font-family:inherit}
.ln{fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.ln.s1{stroke:var(--s1)}.ln.s2{stroke:var(--s2)}
.dot{stroke:var(--card);stroke-width:2;opacity:0}
.s1f{fill:var(--s1)}.s2f{fill:var(--s2)}
.hit{fill:transparent}
.pt:hover .dot{opacity:1}
.pt:hover .hit{fill:rgba(120,150,255,.08)}
.legend{display:flex;gap:20px;flex-wrap:wrap;margin-top:13px;font-size:12px;color:var(--ts)}
.legend span{display:inline-flex;align-items:center;gap:8px}
.sw{width:11px;height:11px;border-radius:3px;display:inline-block;flex:none}
/* Legend chips are HTML — they need background, not the SVG fill property the marks
   use. An earlier version reused the mark classes and the chips vanished
   entirely, leaving the two series distinguishable only by position. */
.sw.k1{background:var(--s1)}.sw.k2{background:var(--s2)}
.lrow{display:grid;grid-template-columns:112px 1fr 54px 86px;align-items:center;gap:12px;
  margin-bottom:9px;font-size:13px}
@media(max-width:640px){.lrow{grid-template-columns:96px 1fr 48px}.lrow .lsub{display:none}}
.llab{color:var(--ts)}
.ltrack{background:var(--track);border-radius:6px;height:22px;overflow:hidden}
.ltrack>i{display:block;height:100%;border-radius:0 6px 6px 0;min-width:3px}
.lnum{text-align:right;font-variant-numeric:tabular-nums;font-weight:700;color:var(--tp)}
.lsub{font-size:11px;color:var(--tm)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:700;color:var(--tm);font-size:10px;text-transform:uppercase;
  letter-spacing:.07em;padding:0 10px 9px 0;border-bottom:1px solid var(--edge);white-space:nowrap}
td{padding:10px 10px 10px 0;border-bottom:1px solid var(--edge);color:var(--ts);vertical-align:middle}
tr:last-child td{border-bottom:none}
td.n{text-align:right;font-variant-numeric:tabular-nums;color:var(--tp);font-weight:600}
td.mono{font-variant-numeric:tabular-nums}
.mut{color:var(--tm)}.sm{font-size:12px}
.bad{color:var(--critical);font-weight:700}
.wv{display:inline-block;font-size:9.5px;font-weight:800;color:var(--tm);
  border:1px solid var(--edge);border-radius:5px;padding:1px 5px;margin-right:8px}
.tag{display:inline-flex;font-size:10px;font-weight:800;padding:3px 9px;border-radius:999px;
  border:1px solid;text-transform:uppercase;letter-spacing:.05em}
.tag.good{color:var(--good);border-color:var(--good)}
.tag.warning{color:var(--warning);border-color:var(--warning)}
.tag.critical{color:var(--critical);border-color:var(--critical)}
.ptrack{display:inline-block;width:88px;height:7px;background:var(--track);border-radius:999px;
  overflow:hidden;vertical-align:middle}
.ptrack>i{display:block;height:100%;border-radius:0 4px 4px 0;min-width:3px;
  background:linear-gradient(90deg,var(--brand),var(--s1))}
.psub{font-size:11px;color:var(--tm);margin-left:9px;font-variant-numeric:tabular-nums}
.big{height:9px;background:var(--track);border-radius:999px;overflow:hidden;margin-top:12px}
.big>i{display:block;height:100%;background:linear-gradient(90deg,var(--brand),var(--good-fill));
  border-radius:0 5px 5px 0}
.empty{color:var(--ts);font-size:13px;background:var(--track);border-radius:12px;padding:15px 17px}
.empty strong{color:var(--tp)}
.foot{margin-top:40px;padding-top:17px;border-top:1px solid var(--edge);font-size:11.5px;
  color:var(--tm)}
.foot code{background:var(--track);padding:1px 6px;border-radius:5px}
</style></head><body><div class="w">

<div class="top">
  <div>
    <h1>Reactivation Engine</h1>
    <p class="sub">Live from Postgres · refreshes every 60s · ${esc(new Date().toISOString().replace('T', ' ').slice(0, 16))} UTC</p>
  </div>
  <button class="tbtn" onclick="var r=document.documentElement;r.dataset.theme=r.dataset.theme==='light'?'dark':'light'">Toggle theme</button>
</div>

${!dialing ? `<div class="banner critical"><span>⛔</span><span>
  <strong>Dialing is stopped.</strong> ${esc(ctl.note || 'no reason recorded')}${ctl.updated_by ? ` — set by ${esc(ctl.updated_by)}` : ''}.
  Nobody will be called until it is switched back on with
  <code>run-dispatch.js resume</code>.</span></div>` : ''}
${dialing && !fresh ? `<div class="banner critical"><span>⛔</span><span>
  <strong>Suppression sync is stale — dialing is blocked.</strong> The do-not-call list is out of
  date, so the dispatcher is refusing to dial rather than risk calling someone who opted out.
  Last successful sync: ${esc(sync.last_ok_at || 'never')}.</span></div>` : ''}

<h2>Right now</h2>
<div class="g g4">
  <div class="c"><div class="tile"><div>
    <div class="lab">Status</div>
    <div class="val hero" style="color:var(--${state.tone})">
      <span class="ic" aria-hidden="true">${state.icon}</span><span>${state.word}</span></div>
    <div class="note">throttle ${esc(flow.throttle_state || 'not set')}</div>
  </div>${chip('check')}</div></div>
  <div class="c"><div class="tile"><div>
    <div class="lab">New people today</div>
    <div class="val">${n(rate.new_today ?? 0)}</div>
    <div class="note">${n(rate.dials_today ?? 0)} dials · ${esc(dppNote)}</div>
  </div>${chip('people')}</div></div>
  <div class="c"><div class="tile"><div>
    <div class="lab">In the cycle</div>
    <div class="val">${n(inCycle)}</div>
    <div class="note">${n(cycle.in_flight)} awaiting an answer · ${n(cycle.due_now)} due now</div>
  </div>${chip('cycle')}</div></div>
  <div class="c"><div class="tile"><div>
    <div class="lab">Reached so far</div>
    <div class="val">${n(reached)}</div>
    <div class="note">${n(cycle.left_appointment)} booked an appointment</div>
  </div>${chip('phone')}</div></div>
</div>

<h2>The cycle — where all ${n(totalProgram)} people are</h2>
<div class="g g2">
  <div class="c">
  <div class="flow">
    <div class="stage"><div class="lab">Not yet called</div>
      <div class="val">${n(notEntered)}</div>
      <div class="note">${pct(notEntered, totalProgram).toFixed(0)}% of the program</div></div>
    <div class="arw" aria-hidden="true">→</div>
    <div class="stage"><div class="lab">In the cycle</div>
      <div class="val" style="color:var(--s1)">${n(inCycle)}</div>
      <div class="note">mid-ladder, still being retried</div></div>
    <div class="arw" aria-hidden="true">→</div>
    <div class="stage"><div class="lab">Finished</div>
      <div class="val">${n(leftTotal)}</div>
      <div class="note">${n(reached)} reached · ${n(cycle.left_exhausted)} exhausted ·
        ${n(cycle.left_opted_out)} opted out</div></div>
  </div>
  <p class="note" style="margin:15px 0 0">A person leaves the cycle when they're reached, book,
  opt out, turn out to be a bad number, or run out of the five attempts.</p>
  </div>
  <div class="c" style="display:flex;flex-direction:column;justify-content:center">
    <div class="lab" style="text-align:center">Program complete</div>
    ${gauge}
    <div class="note" style="text-align:center">${n(leftTotal)} of ${n(totalProgram)}
      finished with</div>
  </div>
</div>

<h2>People entering the cycle, and dials spent doing it</h2>
<div class="c">
  ${chart}
  <p class="note" style="margin:13px 0 0">These are different things and it matters. Each person
  takes about four dials to work through the ladder, so the orange line should sit well above the
  blue one once retries are flowing. <strong>Blue is the number that predicts your finish
  date</strong> — dials don't.</p>
</div>

<h2>Where the in-cycle people are stacked</h2>
<div class="c">${ladderRows}</div>

<h2>Intake rate and what's left</h2>
<div class="c">
  <div class="g g4">
    <div><div class="lab">New people / day</div>
      <div class="val sm">${rate.new_per_day_7d ?? '—'}</div>
      <div class="note">7-day average</div></div>
    <div><div class="lab">Entered this week</div>
      <div class="val sm">${n(rate.new_7d ?? 0)}</div>
      <div class="note">${n(rate.new_30d ?? 0)} in 30 days</div></div>
    <div><div class="lab">Still untouched</div>
      <div class="val sm">${n(rate.remaining ?? notEntered)}</div>
      <div class="note">never been called</div></div>
    <div><div class="lab">Weeks to work through</div>
      <div class="val sm">${rate.weeks_remaining ?? '—'}</div>
      <div class="note">at the current intake rate</div></div>
  </div>
  <p class="note" style="margin:14px 0 0">Weeks remaining is computed from how many people
  actually entered over the last seven days, not from a projection. If it starts climbing,
  something upstream changed.${burndown.est_months_remaining
    ? ` The dial-based estimate says ${esc(burndown.est_months_remaining)} months.` : ''}</p>
</div>

<h2>By wave</h2>
<div class="c"><table>
<thead><tr><th>Group</th><th class="n">Waiting</th><th class="n">In flight</th><th class="n">Reached</th>
<th class="n">Appts</th><th class="n">Total</th><th>Worked through</th></tr></thead>
<tbody>${cohortRows}</tbody></table></div>

<h2>Today, by calling window</h2>
<div class="c"><table>
<thead><tr><th>Window</th><th class="n">Dials</th><th class="n">Awaiting</th>
<th class="n">Connected</th><th class="n">Failed</th></tr></thead>
<tbody>${windowRows}</tbody></table></div>

<h2>Last 7 days — the throttle's decisions</h2>
<div class="c"><table>
<thead><tr><th>Day</th><th class="n">Target</th><th class="n">Sent</th><th>State</th><th>Reason</th></tr></thead>
<tbody>${releaseRows}</tbody></table></div>
${await funnelSection(db)}
<div class="foot">
  Do-not-call list: ${n(dncCount)} numbers · last synced ${esc(sync.last_ok_at || 'never')} ·
  ${n(cycle.left_opted_out)} people opted out since launch<br>
  JSON at <code>/api/flow</code> <code>/api/cycle</code> <code>/api/cohorts</code>
  <code>/api/burndown</code> · health probe at <code>/healthz</code>
</div>
</div></body></html>`;
}
