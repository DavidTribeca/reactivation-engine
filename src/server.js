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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makePool } from './reactivation/db.js';

import { runDispatch, reapStaleInFlight, nightlyRollup, recordOutcome }
  from './reactivation/dispatcher.js';
import { syncSuppression, assertSuppressionSane } from './reactivation/adapters/fub.js';
import { measureRolloverPct } from './reactivation/adapters/isa-list.js';
import { ghlWebhookRouter } from './reactivation/webhook.js';
import { DISPATCH_SLOTS, cronExpr } from './reactivation/schedule.js';
import { renderStatusPage } from './reactivation/status-page.js';
import { runMigrations } from './reactivation/migrate.js';
import { reconcileOutcomes } from './reactivation/reconcile.js';

const TZ = process.env.TZ_NAME || 'America/Los_Angeles';
const PORT = Number(process.env.PORT || 3000);
const ENABLE_CRON = process.env.RE_ENABLE_CRON !== 'false';

const db = makePool({ max: 8 });

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
  // Dispatch times come from DISPATCH_SLOTS so the schedule and the dial
  // windows cannot drift apart — see src/reactivation/schedule.js.
  ...DISPATCH_SLOTS.map((s) => [cronExpr(s), s.name, () => runDispatch(db)]),
  // Runs BEFORE the reaper, deliberately. The reaper turns silence into a
  // no-answer and puts the contact back on the ladder for another call, so
  // anything the SimpleTalk ingest can resolve must be resolved first —
  // otherwise someone who had a real conversation gets dialled again.
  ['45 20 * * *',   'reconcile',          () => reconcileOutcomes(db, recordOutcome)],
  ['0 21 * * *',    'reap',               () => reapStaleInFlight(db)],
  ['30 21 * * *',   'rollup',             async () => {
    // Rollover is measured, not passed in. See adapters/isa-list.js — this is
    // the throttle's capacity signal and it was hardcoded null until now.
    const roll = await measureRolloverPct(db);
    console.log(`[rollup] rollover: ${roll.pct === null ? 'unavailable' : (roll.pct * 100).toFixed(1) + '%'} — ${roll.reason}`);
    return nightlyRollup(db, { rolloverPct: roll.pct });
  }],
  // The watchdog. Every safety mechanism in this engine fails CLOSED — a stale
  // suppression sync halts dialing, a full in-flight ceiling pauses intake, a
  // red throttle cuts volume. Correct, but silent. scripts/health-check.js
  // exists to turn silence into a page, and it documented this exact schedule
  // in its own header while never being wired to anything: it had not run once
  // as of 26 Aug 2026, which is why a four-week ISA backlog went unnoticed.
  ['0 8,13,20 * * *', 'health-check', () => runScript('scripts/health-check.js')],
];

/**
 * Run a script from scripts/ in its own process.
 *
 * health-check.js calls process.exit() by design — non-zero on CRITICAL, so
 * Railway's cron-failure alerting fires as a second independent channel. That
 * makes it unsafe to import into this process: a critical finding would take
 * the server down with it. So it runs as a child, and a non-zero exit is
 * re-thrown here so the cron wrapper logs it as FAILED, which is exactly the
 * signal we want.
 */
const execFileAsync = promisify(execFile);

/**
 * Pull the JSON report out of a script's stdout.
 *
 * The scripts print their report and then keep talking — health-check.js logs
 * "[alert] webhook 200" AFTER the JSON once RE_ALERT_WEBHOOK is set. Parsing
 * from the first "{" to the end of the buffer therefore fed JSON.parse a
 * trailing line and threw, which discarded the entire report. That is exactly
 * what happened on the watchdog's first live run on 26 Aug 2026: the check
 * fired, found real problems and exited 1, and all Railway showed was a bare
 * "Command failed" with no reason attached.
 *
 * So: take the first "{" to the LAST "}" and never let a parse failure lose
 * the underlying error.
 */
function parseReport(out) {
  if (!out) return null;
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Echo the script's own [alert] lines so webhook delivery is visible here. */
function echoAlertLines(out) {
  for (const line of String(out || '').split('\n')) {
    if (line.startsWith('[alert]')) console.log(line);
  }
}

async function runScript(relPath) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [relPath], {
      cwd: process.cwd(),
      env: process.env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    echoAlertLines(stdout);
    if (stderr) echoAlertLines(stderr);
    const parsed = parseReport(stdout);
    return parsed
      ? { status: parsed.status, summary: parsed.summary }
      : { status: 'UNKNOWN', summary: 'script produced no parseable report' };
  } catch (err) {
    // Exit code 1 means CRITICAL findings, not a crash — surface the summary.
    echoAlertLines(err.stdout);
    echoAlertLines(err.stderr);
    const parsed = parseReport(err.stdout);
    if (parsed) {
      const codes = (parsed.findings || [])
        .filter((f) => f.level === 'CRITICAL')
        .map((f) => f.code)
        .join(', ');
      throw new Error(`${parsed.status}: ${parsed.summary}${codes ? ` [${codes}]` : ''}`);
    }
    // No report at all — a genuine crash. The child's stderr is the only clue
    // there is, and swallowing it is how a broken watchdog stays broken.
    const detail = String(err.stderr || '').trim().split('\n').slice(0, 12).join(' | ');
    throw new Error(`${relPath} produced no report: ${err.message.split('\n')[0]}` +
      (detail ? ` — stderr: ${detail}` : ' — stderr was empty'));
  }
}

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

app.get('/api/cycle', async (_req, res) => {
  const [{ rows: [cycle] }, { rows: [rate] }, { rows: ladder }, { rows: intake }] =
    await Promise.all([
      db.query(`SELECT * FROM re_v_cycle`),
      db.query(`SELECT * FROM re_v_intake_rate`),
      db.query(`SELECT * FROM re_v_ladder_position`),
      db.query(`SELECT day::text AS day, new_people, dials, connects
                  FROM re_v_intake_daily ORDER BY day`),
    ]);
  res.json({ cycle, rate, ladder, intake });
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

/**
 * Boot: schema first, then listen, then schedule.
 *
 * The order matters. Cron must not start before the schema exists — the 15-min
 * suppression sync would fire against missing tables, fail, and stamp the sync
 * as failed, which is the state that halts dialing. And the process exits
 * rather than serving on a broken schema: a visible failed deploy in Railway
 * beats a green one that silently cannot dispatch.
 */
async function boot() {
  try {
    await runMigrations(db);
  } catch (err) {
    console.error(`[server] REFUSING TO START — ${err.message}`);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`[server] listening on ${PORT} (tz ${TZ})`);
    if (ENABLE_CRON) startCron();
    else console.log('[cron] DISABLED via RE_ENABLE_CRON=false — HTTP only');
  });
}

boot();

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`[server] ${sig} — shutting down`);
    await db.end().catch(() => {});
    process.exit(0);
  });
}
