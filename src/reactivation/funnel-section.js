/**
 * Funnel subsection for the live status page — calls → answered → appointments.
 *
 * WHY IT LIVES HERE AND NOT IN A SEPARATE PAGE
 *
 * The status page is already the thing that gets bookmarked, already renders
 * server-side, and already refreshes itself every 60 seconds. A separate
 * dashboard would need its own hosting, its own CORS allowance, and would drift
 * out of step with the numbers on this page. So this renders into the same
 * document, using the same card classes and the same rung ramp, and inherits
 * the auto-refresh for free.
 *
 * All three grains — day, week, month — are rendered at request time and the
 * toggle only shows and hides them. No fetch, no loading state, no way for the
 * toggle to disagree with the tiles above it.
 *
 * ── THE ONE MEASUREMENT DECISION THAT MATTERS ─────────────────────────────
 *
 * `awaiting` is its own stage, and rates are measured against RESOLVED calls
 * (placed minus awaiting), never against calls placed.
 *
 * An attempt with a NULL outcome is a call that went out and has not reported
 * back. It is NOT a call nobody answered. Dividing by calls-placed silently
 * turns a reporting gap into a bad answer rate, and that is not hypothetical
 * here: on 2026-08-10 the first live batch of 60 produced 60 real conversations
 * and two appointments, and the engine recorded none of them because the
 * reconciler was joining on an empty column. A dashboard doing the naive
 * division would have displayed a confident 0% and blamed the calling.
 *
 * So the awaiting count sits next to every rate, and when the gap is large the
 * section says so in words. A broken outcome feed should look like a broken
 * outcome feed.
 */

/** Same zone cron runs in, so the day boundary on this chart matches the dial windows. */
const TZ = process.env.TZ_NAME || 'America/Los_Angeles';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString());
const rate = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '—');

/** Every stage counted off one scan, so they can never disagree with each other. */
const STAGES = `
  count(*)::int                                                     AS calls,
  count(*) FILTER (WHERE outcome IS NULL)::int                       AS awaiting,
  count(*) FILTER (WHERE outcome IN ('reached','appointment'))::int   AS answered,
  count(*) FILTER (WHERE outcome = 'appointment')::int               AS appointments,
  count(*) FILTER (WHERE outcome = 'voicemail')::int                 AS voicemail,
  count(*) FILTER (WHERE outcome = 'no_answer')::int                 AS no_answer,
  count(*) FILTER (WHERE outcome = 'opted_out')::int                 AS opted_out,
  count(*) FILTER (WHERE outcome = 'bad_number')::int                AS bad_number`;

/** How many periods to plot, and how many to list in the table, per grain. */
const GRAINS = [
  { key: 'day',   label: 'Daily',   chart: 30, table: 14, word: 'day' },
  { key: 'week',  label: 'Weekly',  chart: 26, table: 10, word: 'week' },
  { key: 'month', label: 'Monthly', chart: 18, table: 12, word: 'month' },
];

/**
 * Pull the funnel at all three grains plus all-time totals.
 *
 * Buckets by LOCAL time. A 4pm Pacific dial is 23:00 UTC, so truncating in UTC
 * would file every afternoon batch under the following day and make the daily
 * column quietly wrong.
 */
export async function funnelData(db, tz = TZ) {
  const one = (grain, limit) => db.query(
    `SELECT date_trunc($1, pushed_at AT TIME ZONE $2)::date::text AS period, ${STAGES}
       FROM re_attempt
      WHERE push_ok
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $3`,
    [grain, tz, limit],
  ).then((r) => r.rows.reverse());

  const [day, week, month, totals] = await Promise.all([
    ...GRAINS.map((g) => one(g.key, g.chart)),
    db.query(`SELECT ${STAGES} FROM re_attempt WHERE push_ok`).then((r) => r.rows[0] || {}),
  ]);

  return { day, week, month, totals };
}

function fmtPeriod(iso, grain, short) {
  const d = new Date(`${iso}T00:00:00Z`);
  const o = { timeZone: 'UTC' };
  if (grain === 'month') {
    return d.toLocaleDateString('en-US', { ...o, month: short ? 'short' : 'long', year: 'numeric' });
  }
  if (grain === 'week') {
    return (short ? '' : 'Week of ') + d.toLocaleDateString('en-US', { ...o, month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', short
    ? { ...o, month: 'numeric', day: 'numeric' }
    : { ...o, weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Grouped bars, three stages per period. Grouped and not stacked on purpose:
 * answered and appointments are SUBSETS of calls, so stacking them would draw a
 * total that does not exist. Awaiting is drawn as a muted overlay on the calls
 * bar, which makes an unreported batch visible in the shape of the chart.
 */
function chart(periods, grain) {
  if (!periods.length || !periods.some((p) => p.calls > 0)) {
    return `<div class="empty"><strong>No calls recorded yet.</strong> This fills in from
      re_attempt as soon as the first batch goes out — one group of bars per ${grain}.</div>`;
  }

  const W = 780, H = 200, PL = 40, PR = 12, PT = 14, PB = 28;
  const iw = W - PL - PR, ih = H - PT - PB;
  const max = Math.max(1, ...periods.map((p) => Number(p.calls) || 0));
  const step = iw / periods.length;
  const bw = Math.max(2, Math.min(13, step / 3.8));
  const Y = (v) => PT + ih - (v / max) * ih;
  const ticks = [...new Set([0, Math.round(max / 2), max])];
  const everyNth = Math.ceil(periods.length / 10);

  let s = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img"
    aria-label="Calls, answered and appointments per ${grain}">`;
  for (const t of ticks) {
    s += `<line x1="${PL}" y1="${Y(t).toFixed(1)}" x2="${W - PR}" y2="${Y(t).toFixed(1)}"
      stroke="var(--track)" stroke-width="1"/>`
      + `<text x="${PL - 7}" y="${(Y(t) + 3.5).toFixed(1)}" text-anchor="end"
        font-size="9.5" fill="var(--tm)">${t.toLocaleString()}</text>`;
  }

  periods.forEach((p, i) => {
    const cx = PL + step * i + step / 2;
    const series = [
      { v: Number(p.calls) || 0, c: 'var(--rung-2)', k: 'calls placed' },
      { v: Number(p.answered) || 0, c: 'var(--rung-3)', k: 'answered' },
      { v: Number(p.appointments) || 0, c: 'var(--rung-5)', k: 'appointments' },
    ];
    const gw = series.length * bw + (series.length - 1) * 2;
    series.forEach((ser, j) => {
      if (ser.v <= 0) return;
      const x = cx - gw / 2 + j * (bw + 2);
      const h = Math.max(1.5, PT + ih - Y(ser.v));
      s += `<rect x="${x.toFixed(1)}" y="${(PT + ih - h).toFixed(1)}" width="${bw.toFixed(1)}"
        height="${h.toFixed(1)}" rx="1.5" fill="${ser.c}"><title>${esc(fmtPeriod(p.period, grain))
        } — ${ser.k}: ${ser.v.toLocaleString()}</title></rect>`;
    });
    const aw = Number(p.awaiting) || 0;
    if (aw > 0) {
      const x = cx - gw / 2;
      s += `<rect x="${x.toFixed(1)}" y="${Y(aw).toFixed(1)}" width="${bw.toFixed(1)}"
        height="${((aw / max) * ih).toFixed(1)}" rx="1.5" fill="var(--tm)" opacity=".6"
        ><title>${esc(fmtPeriod(p.period, grain))} — awaiting outcome: ${aw.toLocaleString()}</title></rect>`;
    }
    if (i % everyNth === 0 || periods.length <= 10) {
      s += `<text x="${cx.toFixed(1)}" y="${H - 9}" text-anchor="middle" font-size="9.5"
        fill="var(--tm)">${esc(fmtPeriod(p.period, grain, true))}</text>`;
    }
  });

  s += `<line x1="${PL}" y1="${(PT + ih).toFixed(1)}" x2="${W - PR}" y2="${(PT + ih).toFixed(1)}"
    stroke="var(--edge)" stroke-width="1"/></svg>`;
  return s;
}

function table(periods, grain, limit) {
  const rows = [...periods].reverse().slice(0, limit).filter((p) => Number(p.calls) > 0);
  if (!rows.length) return '';

  let html = `<table class="ft"><thead><tr>
    <th>${grain === 'day' ? 'Day' : grain === 'week' ? 'Week' : 'Month'}</th>
    <th>Calls</th><th>Awaiting</th><th>Answered</th><th>Answer&nbsp;rate</th>
    <th>Appts</th><th>Appt&nbsp;rate</th></tr></thead><tbody>`;

  for (const p of rows) {
    const calls = Number(p.calls) || 0;
    const aw = Number(p.awaiting) || 0;
    const res = calls - aw;
    const ans = Number(p.answered) || 0;
    const ap = Number(p.appointments) || 0;
    html += `<tr><td>${esc(fmtPeriod(p.period, grain))}</td><td>${n(calls)}</td>`
      + `<td${aw ? ' class="warn"' : ''}>${aw ? n(aw) : '—'}</td><td>${n(ans)}</td>`
      + `<td>${rate(ans, res)}</td><td>${ap ? n(ap) : '—'}</td><td>${ans ? rate(ap, ans) : '—'}</td></tr>`;
  }
  return `${html}</tbody></table>`;
}

/** The section itself. Never throws — a broken funnel must not blank the page. */
export async function funnelSection(db, tz = TZ) {
  let data;
  try {
    data = await funnelData(db, tz);
  } catch (err) {
    return `<h2>Calls → answered → appointments</h2><div class="c"><div class="empty">
      <strong>Funnel unavailable.</strong> ${esc(err.message)}</div></div>`;
  }

  const t = data.totals || {};
  const calls = Number(t.calls) || 0;
  const awaiting = Number(t.awaiting) || 0;
  const answered = Number(t.answered) || 0;
  const appts = Number(t.appointments) || 0;
  const resolved = calls - awaiting;

  // The honesty line. Everything above it is arithmetic; this is the judgement.
  let caveat = '';
  if (calls && resolved === 0) {
    caveat = `<div class="fnote crit"><strong>Nothing has reported back yet.</strong>
      All ${n(calls)} calls placed are still awaiting an outcome, so there are no rates to
      show. If that holds for more than a day the outcome feed is broken — not the calling.</div>`;
  } else if (awaiting > 0) {
    caveat = `<div class="fnote warn"><strong>${n(awaiting)} call${awaiting === 1 ? '' : 's'}
      awaiting an outcome.</strong> Calls that went out and have not reported back — not calls
      nobody answered. Every rate here is measured against the ${n(resolved)} that have
      reported, so this gap cannot read as poor performance.</div>`;
  } else if (!calls) {
    caveat = `<div class="fnote"><strong>No calls yet.</strong> Fills in with the first batch.</div>`;
  }

  const tiles = [
    ['Calls placed', n(calls), 'all time', 'var(--rung-2)'],
    ['Answered', n(answered), resolved ? `${rate(answered, resolved)} of resolved` : 'awaiting outcomes', 'var(--rung-3)'],
    ['Appointments', n(appts), answered ? `${rate(appts, answered)} of answered` : 'none yet', 'var(--rung-5)'],
    ['Awaiting outcome', n(awaiting), awaiting ? 'not yet reported' : 'all reported', 'var(--tm)'],
  ].map(([lab, val, note, col]) => `<div class="c"><div class="lab">
      <span class="fsw" style="background:${col}"></span>${esc(lab)}</div>
    <div class="val">${val}</div><div class="note">${esc(note)}</div></div>`).join('');

  const conv = [
    ['Answer rate', rate(answered, resolved), answered, resolved,
      `${n(answered)} answered of ${n(resolved)} resolved`],
    ['Appointment rate', answered ? rate(appts, answered) : '—', appts, answered,
      `${n(appts)} booked of ${n(answered)} answered`],
    ['Overall conversion', resolved ? rate(appts, resolved) : '—', appts, resolved,
      appts ? `about 1 appointment per ${Math.round(resolved / appts)} resolved calls`
            : 'no appointments recorded yet'],
  ].map(([lab, val, num, den, note]) => {
    const w = den > 0 ? Math.max(0, Math.min(100, (100 * num) / den)) : 0;
    return `<div><div class="lab">${esc(lab)}</div><div class="val sm">${val}</div>
      <div class="ftrack"><i style="width:${w.toFixed(1)}%"></i></div>
      <div class="note">${esc(note)}</div></div>`;
  }).join('');

  const panels = GRAINS.map((g, i) => `<div class="fpanel" data-grain="${g.key}"
    ${i ? 'hidden' : ''}>${chart(data[g.key], g.key)}${table(data[g.key], g.key, g.table)}</div>`).join('');

  const buttons = GRAINS.map((g, i) => `<button class="tbtn fgb${i ? '' : ' on'}"
    data-show="${g.key}" aria-pressed="${i ? 'false' : 'true'}">${g.label}</button>`).join('');

  return `
<h2>Calls → answered → appointments</h2>
<style>
.fsw{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:6px;vertical-align:1px}
.fgrp{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px}
.tbtn.on{color:var(--tp);border-color:var(--s1);background:var(--card2)}
.fconv{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
@media(max-width:700px){.fconv{grid-template-columns:1fr}}
.ftrack{height:6px;border-radius:99px;background:var(--track);overflow:hidden;margin:7px 0 6px}
.ftrack i{display:block;height:100%;border-radius:99px;background:var(--rung-4)}
.fnote{font-size:12px;color:var(--ts);border-left:2px solid var(--edge);padding:2px 0 2px 11px;margin-top:14px}
.fnote.warn{border-left-color:var(--warning)}
.fnote.crit{border-left-color:var(--critical)}
table.ft{width:100%;border-collapse:collapse;font-size:12px;margin-top:16px;
  font-variant-numeric:tabular-nums}
table.ft th{font-size:9.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--tm);
  font-weight:700;text-align:right;padding:6px 8px;border-bottom:1px solid var(--edge)}
table.ft th:first-child,table.ft td:first-child{text-align:left;font-variant-numeric:normal}
table.ft td{text-align:right;padding:6px 8px;border-bottom:1px solid var(--track);color:var(--ts)}
table.ft td:first-child{color:var(--tp)}
table.ft td.warn{color:var(--warning)}
</style>
<div class="g g4">${tiles}</div>
<div class="c" style="margin-top:14px">
  <div class="fconv">${conv}</div>
  ${caveat}
</div>
<div class="c" style="margin-top:14px">
  <div class="fgrp">${buttons}</div>
  ${panels}
  <div class="note" style="margin-top:12px">Grouped bars — answered and appointments are
    subsets of calls, not additions to it. Muted overlay is calls still awaiting an outcome.
    Answered means a human conversation happened; voicemail does not count.</div>
</div>
<script>
(function () {
  for (const b of document.querySelectorAll('.fgb')) {
    b.addEventListener('click', function () {
      for (const o of document.querySelectorAll('.fgb')) {
        const on = o === b;
        o.classList.toggle('on', on);
        o.setAttribute('aria-pressed', String(on));
      }
      for (const p of document.querySelectorAll('.fpanel')) {
        p.hidden = p.dataset.grain !== b.dataset.show;
      }
    });
  }
})();
</script>`;
}
