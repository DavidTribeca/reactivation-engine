/**
 * Live status page, server-rendered from the tracking views.
 *
 * This is the difference between the tracker HTML (a snapshot of the plan) and
 * knowing what the system is doing right now. Bookmark the service URL.
 *
 * Deliberately dependency-free and self-contained: no build step, no client
 * framework, no external requests. If this page renders, the database is
 * reachable and the views are intact — which is itself a useful signal.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString());

export async function renderStatusPage(db) {
  const [flow, cohorts, burndown, today, release, sync, ctl] = await Promise.all([
    db.query(`SELECT * FROM re_v_flow`).then((r) => r.rows[0] || {}),
    db.query(`SELECT * FROM re_v_cohort_status`).then((r) => r.rows),
    db.query(`SELECT * FROM re_v_burndown`).then((r) => r.rows[0] || {}).catch(() => ({})),
    db.query(`SELECT * FROM re_v_today_by_window`).then((r) => r.rows).catch(() => []),
    db.query(`SELECT *, release_date::text AS day FROM re_daily_release
                ORDER BY release_date DESC LIMIT 7`).then((r) => r.rows),
    db.query(`SELECT * FROM re_sync_state WHERE key='suppression'`).then((r) => r.rows[0] || {}),
    db.query(`SELECT * FROM re_control WHERE key='dialing_enabled'`).then((r) => r.rows[0] || {}),
  ]);

  const dialing = ctl.value === 'true';
  const supFresh = flow.suppression_fresh;
  const health = !dialing ? ['STOPPED', 'var(--critical)']
    : !supFresh ? ['BLOCKED', 'var(--critical)']
    : (flow.throttle_state === 'red') ? ['THROTTLED', 'var(--warning)']
    : ['RUNNING', 'var(--good)'];

  const bar = (pct, color) =>
    `<div class="t"><div class="f" style="width:${Math.max(0, Math.min(100, pct))}%;background:${color}"></div></div>`;

  const cohortRows = cohorts.map((c) => {
    const worked = Number(c.total) - Number(c.waiting);
    const pct = c.total > 0 ? (100 * worked) / Number(c.total) : 0;
    return `<tr><td>${esc(c.label || c.cohort)}</td><td class="n">${n(c.waiting)}</td>
      <td class="n">${n(c.in_flight)}</td><td class="n">${n(c.reached)}</td>
      <td class="n">${n(c.appointments)}</td><td class="n">${n(c.total)}</td>
      <td style="width:22%">${bar(pct, 'var(--series-1)')}<span class="s">${pct.toFixed(0)}% worked</span></td></tr>`;
  }).join('');

  const releaseRows = release.map((r) => {
    const c = r.throttle_state === 'red' ? 'var(--critical)'
      : r.throttle_state === 'yellow' ? 'var(--warning)' : 'var(--good)';
    // release_date is rendered from ::text, not re-parsed through a JS Date —
    // a DATE round-tripped through Date() shifts a day in any timezone east of UTC.
    return `<tr><td>${esc(r.day)}</td>
      <td class="n">${n(r.target_dials)}</td><td class="n">${n(r.actual_pushed)}</td>
      <td><span style="color:${c};font-weight:600">${esc(r.throttle_state)}</span></td>
      <td class="s">${esc((r.throttle_reason || '').slice(0, 90))}</td></tr>`;
  }).join('');

  const windowRows = today.length ? today.map((w) =>
    `<tr><td>${esc(w.window_label)}</td><td class="n">${n(w.pushed)}</td>
     <td class="n">${n(w.awaiting_outcome)}</td><td class="n">${n(w.connects)}</td>
     <td class="n">${n(w.push_failures)}</td></tr>`).join('')
    : `<tr><td colspan="5" class="s">No dials yet today.</td></tr>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Reactivation Engine — live</title><style>
:root{color-scheme:light;--s0:#f4f3f0;--s1:#fcfcfb;--s2:#eeede9;--bd:#dedcd6;
--tp:#0b0b0b;--ts:#52514e;--tm:#78766f;--series-1:#2a78d6;--good:#0ca30c;--warning:#fab219;--critical:#d03b3b}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--s0:#111110;--s1:#1a1a19;--s2:#242422;--bd:#383835;
--tp:#fff;--ts:#c3c2b7;--tm:#94938b;--series-1:#3987e5}}
*{box-sizing:border-box}body{margin:0;background:var(--s0);color:var(--tp);
font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
.w{max-width:1060px;margin:0 auto;padding:28px 22px 60px}
h1{font-size:22px;margin:0 0 3px;letter-spacing:-.02em}
.sub{color:var(--ts);font-size:13px;margin:0 0 22px}
h2{font-size:11.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--tm);margin:30px 0 11px;font-weight:600}
.c{background:var(--s1);border:1px solid var(--bd);border-radius:11px;padding:17px 19px}
.g{display:grid;gap:12px;grid-template-columns:repeat(4,1fr)}
@media(max-width:820px){.g{grid-template-columns:1fr 1fr}}
.lab{font-size:11.5px;color:var(--tm);text-transform:uppercase;letter-spacing:.06em}
.val{font-size:28px;font-weight:650;letter-spacing:-.025em;margin:4px 0 1px;font-variant-numeric:tabular-nums}
.note{font-size:12px;color:var(--ts)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:600;color:var(--tm);font-size:11px;text-transform:uppercase;
letter-spacing:.05em;padding:0 9px 8px 0;border-bottom:1px solid var(--bd)}
td{padding:8px 9px 8px 0;border-bottom:1px solid var(--bd)}tr:last-child td{border-bottom:none}
td.n{text-align:right;font-variant-numeric:tabular-nums}
.t{background:var(--s2);border-radius:3px;height:7px;overflow:hidden}
.f{height:100%;border-radius:0 3px 3px 0}
.s{font-size:11.5px;color:var(--ts)}
.foot{margin-top:34px;padding-top:15px;border-top:1px solid var(--bd);font-size:12px;color:var(--tm)}
.banner{border-radius:9px;padding:11px 15px;margin-bottom:18px;font-size:13.5px;font-weight:600}
</style></head><body><div class="w">

<h1>Reactivation Engine</h1>
<p class="sub">Live from Postgres · auto-refreshes every 60s · ${esc(new Date().toISOString())}</p>

${!dialing ? `<div class="banner" style="background:var(--critical);color:#fff">
  ⛔ DIALING STOPPED — "${esc(ctl.note || 'no reason recorded')}" by ${esc(ctl.updated_by || '?')}.
  Resume with <code>run-dispatch.js resume</code>.</div>` : ''}
${dialing && !supFresh ? `<div class="banner" style="background:var(--critical);color:#fff">
  ⛔ SUPPRESSION SYNC STALE — the dispatcher is refusing to dial. Last ok: ${esc(sync.last_ok_at || 'never')}.</div>` : ''}

<h2>Right now</h2>
<div class="g">
  <div class="c"><div class="lab">Status</div>
    <div class="val" style="color:${health[1]}">${health[0]}</div>
    <div class="note">throttle ${esc(flow.throttle_state || 'n/a')}</div></div>
  <div class="c"><div class="lab">In flight</div><div class="val">${n(flow.in_flight_now)}</div>
    <div class="note">awaiting an outcome</div></div>
  <div class="c"><div class="lab">Pushed today</div>
    <div class="val">${n(flow.pushed_today)}</div>
    <div class="note">of ${n(flow.target_today)} target</div></div>
  <div class="c"><div class="lab">Due now</div><div class="val">${n(flow.due_now)}</div>
    <div class="note">${n(flow.due_tomorrow)} due tomorrow</div></div>
</div>

<h2>Program progress</h2>
<div class="c">
  <div class="g" style="grid-template-columns:repeat(4,1fr)">
    <div><div class="lab">Complete</div><div class="val">${burndown.pct_complete ?? '—'}%</div></div>
    <div><div class="lab">Remaining</div><div class="val">${n(burndown.remaining)}</div></div>
    <div><div class="lab">Per day (14d)</div><div class="val">${burndown.contacts_per_day_14d ?? '—'}</div></div>
    <div><div class="lab">Est. months left</div><div class="val">${burndown.est_months_remaining ?? '—'}</div></div>
  </div>
  <div style="margin-top:13px">${bar(Number(burndown.pct_complete || 0), 'var(--good)')}</div>
  <p class="s" style="margin:8px 0 0">Months remaining is recomputed from your actual 14-day throughput —
  it corrects the original projection with reality rather than assumption.</p>
</div>

<h2>By cohort</h2>
<div class="c"><table>
<thead><tr><th>Cohort</th><th class="n">Waiting</th><th class="n">In flight</th><th class="n">Reached</th>
<th class="n">Appts</th><th class="n">Total</th><th>Progress</th></tr></thead>
<tbody>${cohortRows || '<tr><td colspan="7" class="s">No contacts imported yet.</td></tr>'}</tbody></table></div>

<h2>Today, by window</h2>
<div class="c"><table>
<thead><tr><th>Window</th><th class="n">Pushed</th><th class="n">Awaiting</th>
<th class="n">Connects</th><th class="n">Push failures</th></tr></thead>
<tbody>${windowRows}</tbody></table></div>

<h2>Last 7 days</h2>
<div class="c"><table>
<thead><tr><th>Date</th><th class="n">Target</th><th class="n">Pushed</th><th>Throttle</th><th>Reason</th></tr></thead>
<tbody>${releaseRows || '<tr><td colspan="5" class="s">No release history yet.</td></tr>'}</tbody></table></div>

<div class="foot">
  Suppression last synced ${esc(sync.last_ok_at || 'never')} · ${n(flow.suppressed_total)} suppressed ·
  ${n(flow.opted_out_total)} opted out · ${n(flow.total_in_program)} in program<br>
  JSON at <code>/api/flow</code>, <code>/api/cohorts</code>, <code>/api/burndown</code> · probe at <code>/healthz</code>
</div>
</div></body></html>`;
}
