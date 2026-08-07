/**
 * Entry point — this is the process that Railway runs.
 *
 * WHERE THIS LIVES
 *   GitHub          DavidTribeca/reactivation-engine  (source of truth)
 *   Railway         project "compassionate-contentment", its own service,
 *                   deployed from that repo, sharing the existing Postgres
 *   Postgres        all queue state — the re_* tables
 *   FUB / GHL       reached over HTTPS; nothing is installed there
 *   SimpleTalk      does the actual dialling, driven by the GHL workflow
 *
 * Deployed as its own Railway service rather than folded into isa-call-list.
 * That service works today and keeps your ISAs supplied; a bad deploy here
 * should not take it down. They share the Postgres through a reference
 * variable, so there is still one source of truth for state.
 *
 * This process does three things:
 *   1. runs the internal cron schedule (no external scheduler needed)
 *   2. serves a live status page and JSON at "/" and "/api/*"
 *   3. receives GHL webhooks at /webhooks/ghl
 *
 * Every cron job is also runnable by hand from scripts/ — the schedule here
 * calls the same functions, so nothing behaves differently when automated.
 */

import express from 'express';
import cron from 'node-cron';
import pg from 'pg';

import { runDispatch, reapStaleInFlight, nightlyRollup } from './reactivation/dispatcher.js';
import { syncSuppression, assertSuppressionSane } from './reactivation/adapters/fub.js';
import { ghlWebhookRouter } from './reactivation/webhook.js';
import { renderStatusPage } from './reactivation/status-page.js';

const TZ = process.env.TZ_NAME || 'America/Los_Angeles';
const PORT = Number(process.env.PORT || 3000);
const ENABLE_CRON = process.env.RE_ENABLE_CRON !== 'false';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });

// ---------------------------------------------------------------------------
// Cron. Times are America/Los_Angeles and line up with the ladder's windows.
// ---------------------------------------------------------------------------

const JOBS = [
  ['*/15 * * * *',  'suppression-sync',  async () => {
    const r = await syncSuppression(db, { mode: 'incremental' });
    assertSuppressionSane(r);
    await stampSync(true, `incremental: +${r.added}`);
  }],
  ['15 3 * * *',    'suppression-full',  async () => {
    const r = await syncSuppression(db, { mode: 'full' });
    assertSuppressionSane(r);
    await stampSync(true, `full: +${r.added}`);
  }],
  ['0 10 * * 1-6',  'dispatch-morning',   () => runDispatch(db)],
  ['0 16 * * 1-6',  'dispatch-afternoon', () => runDispatch(db)],
  ['0 18 * * 1-5',  'dispatch-evening',   () => runDispatch(db)],
  ['0 21 * * *',    'reap',               () => reapStaleInFlight(db)],
  ['30 21 * * *',   'rollup',             () => nightlyRollup(db, { rolloverPct: null })],
];

async function stampSync(ok, detail) {
  await db.query(
    `INSERT INTO re_sync_state (key, last_run_at, last_ok_at, ok, detail)
     VALUES ('suppression', now(), CASE WHEN $1 THEN now() END, $1, $2)
     ON CONFLICT (key) DO UPDATE
       SET last_run_at = now(),
           last_ok_at = CASE WHEN $1 THEN now() ELSE re_sync_state.last_ok_at END,
           ok = $1, detail = $2`,
    [ok, detail]);
}

function startCron() {
  for (const [expr, name, fn] of JOBS) {
    cron.schedule(expr, async () => {
      const t0 = Date.now();
      try {
        const out = await fn();
        console.log(`[cron:${name}] ok in ${Date.now() - t0}ms ${out ? JSON.stringify(out) : ''}`);
      } catch (err) {
        console.error(`[cron:${name}] FAILED: ${err.message}`);
        // A failed suppression sync must not leave last_ok_at looking fresh —
        // the dispatcher reads it and would otherwise resume dialling blind.
        if (name.startsWith('suppression')) {
          await stampSync(false, `FAILED: ${err.message}`).catch(() => {});
        }
      }
    }, { timezone: TZ });
    console.log(`[cron] scheduled ${name.padEnd(20)} ${expr}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();

app.use('/webhooks/ghl', ghlWebhookRouter(db));

/** Live status page — the thing to bookmark. */
app.get('/', async (_req, res) => {
  try {
    res.type('html').send(await renderStatusPage(db));
  } catch (err) {
    res.status(500).type('text').send(`status page failed: ${err.message}`);
  }
});

/** Machine-readable equivalents. */
app.get('/api/flow', async (_req, res) => {
  const { rows: [flow] } = await db.query(`SELECT * FROM re_v_flow`);
  res.json(flow);
});

app.get('/api/cohorts', async (_req, res) => {
  const { rows } = await db.query(`SELECT * FROM re_v_cohort_status`);
  res.json(rows);
});

app.get('/api/burndown', async (_req, res) => {
  const { rows: [b] } = await db.query(`SELECT * FROM re_v_burndown`);
  res.json(b);
});

/** Railway health probe. 503 when dialling is blocked, so it shows in Railway. */
app.get('/healthz', async (_req, res) => {
  try {
    const { rows: [h] } = await db.query(
      `SELECT re_dialing_enabled() AS dialing, re_suppression_is_fresh(120) AS suppression`);
    const ok = h.dialing && h.suppression;
    res.status(ok ? 200 : 503).json({ ok, ...h });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on ${PORT} (tz ${TZ})`);
  if (ENABLE_CRON) startCron();
  else console.log('[cron] DISABLED via RE_ENABLE_CRON=false — HTTP only');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`[server] ${sig} — shutting down`);
    await db.end().catch(() => {});
    process.exit(0);
  });
}
