-- ============================================================
-- Reactivation Engine — schema
-- Tribeca NW · SimpleTalk 30k database program
--
-- Safe to run against the existing isa-call-list Postgres.
-- Creates only new tables prefixed `re_` so nothing existing collides.
-- Idempotent: re-running is a no-op.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Lookup: cohorts (waves). Ordered by `wave` = dial priority.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS re_cohort (
  code            text PRIMARY KEY,
  wave            smallint NOT NULL,
  label           text NOT NULL,
  -- Gate: cohort will not release until this date, even if earlier waves are dry.
  -- NULL = releasable as soon as earlier waves drain.
  not_before      date,
  -- Set false to freeze a cohort without deleting it.
  active          boolean NOT NULL DEFAULT true
);

INSERT INTO re_cohort (code, wave, label, not_before) VALUES
  ('hot_engaged',   1, 'Top-decile engagement score',            NULL),
  ('recent_0_90',   1, 'Leads 0-90 days old',                    NULL),
  ('recent_91_365', 2, 'Leads 91-365 days old',                  NULL),
  ('past_client',   2, 'Past clients and sphere',                NULL),
  ('dormant_1_3y',  3, 'Dormant 1-3 years',                      NULL),
  ('dormant_3y',    4, 'Dormant 3+ years',                       NULL),
  ('recycled',      4, 'Attempt-exhausted, re-eligible at d120', NULL)
ON CONFLICT (code) DO NOTHING;


-- ------------------------------------------------------------
-- Suppression list. Checked on EVERY push, no exceptions.
-- This is the compliance safety net — keep it append-only.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS re_suppression (
  phone_e164   text PRIMARY KEY,
  reason       text NOT NULL
    CHECK (reason IN (
      'dnc_national','internal_dnc','opt_out','litigator',
      'reassigned_number','bad_number','client_active','manual'
    )),
  source       text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- The queue. One row per person in the program.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS re_contact (
  id                bigserial PRIMARY KEY,

  -- identity across systems
  fub_person_id     bigint UNIQUE,
  ghl_contact_id    text,
  first_name        text,
  last_name         text,
  phone_e164        text NOT NULL,
  email             text,
  timezone          text NOT NULL DEFAULT 'America/Los_Angeles',

  -- segmentation
  cohort_code       text NOT NULL REFERENCES re_cohort(code),
  priority_score    numeric NOT NULL DEFAULT 0,   -- FUB engagement score; higher dials first
  consent_tier      text NOT NULL DEFAULT 'unknown'
    CHECK (consent_tier IN ('written','ebr_current','ebr_expired','unknown')),

  -- state machine
  status            text NOT NULL DEFAULT 'eligible'
    CHECK (status IN (
      'eligible',      -- waiting, due at next_eligible_at
      'in_flight',     -- pushed to SimpleTalk, awaiting outcome
      'reached',       -- live conversation happened — terminal, handed to ISA
      'appointment',   -- booked — terminal
      'exhausted',     -- ran out of attempts — terminal until recycled
      'opted_out',     -- terminal, also in re_suppression
      'invalid_phone', -- terminal, also in re_suppression
      'suppressed',    -- blocked by suppression check
      'paused'         -- manual hold
    )),
  attempt_count     smallint NOT NULL DEFAULT 0,
  max_attempts      smallint NOT NULL DEFAULT 5,
  next_eligible_at  timestamptz NOT NULL DEFAULT now(),
  last_pushed_at    timestamptz,
  last_outcome      text,
  last_outcome_at   timestamptz,

  -- audit
  suppressed_reason text,
  imported_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The dispatcher's hot path: "who is due, in wave order, highest score first".
CREATE INDEX IF NOT EXISTS re_contact_due_idx
  ON re_contact (status, next_eligible_at, priority_score DESC)
  WHERE status = 'eligible';

CREATE INDEX IF NOT EXISTS re_contact_cohort_idx  ON re_contact (cohort_code, status);
CREATE INDEX IF NOT EXISTS re_contact_phone_idx   ON re_contact (phone_e164);
CREATE INDEX IF NOT EXISTS re_contact_inflight_idx ON re_contact (status, last_pushed_at)
  WHERE status = 'in_flight';


-- ------------------------------------------------------------
-- Append-only attempt log. Never UPDATE except to set outcome.
-- This is what lets you compute real answer rates per window,
-- per cohort, per attempt number — the data that replaces every
-- estimate in the plan.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS re_attempt (
  id              bigserial PRIMARY KEY,
  contact_id      bigint NOT NULL REFERENCES re_contact(id) ON DELETE CASCADE,
  attempt_number  smallint NOT NULL,
  window_label    text NOT NULL,   -- mid_morning | late_afternoon | evening | saturday_am
  pushed_at       timestamptz NOT NULL DEFAULT now(),
  push_ok         boolean NOT NULL DEFAULT true,
  push_error      text,
  from_number     text,            -- which caller ID was used, for reputation tracking
  outcome         text,            -- no_answer | voicemail | reached | appointment | opted_out | bad_number
  outcome_at      timestamptz,
  simpletalk_conversation_id text,
  raw             jsonb
);

CREATE INDEX IF NOT EXISTS re_attempt_contact_idx ON re_attempt (contact_id, attempt_number);
CREATE INDEX IF NOT EXISTS re_attempt_pushed_idx  ON re_attempt (pushed_at);
CREATE INDEX IF NOT EXISTS re_attempt_number_idx  ON re_attempt (from_number, pushed_at);


-- ------------------------------------------------------------
-- Daily release ledger — the throttle's memory.
-- One row per calendar day. The dispatcher reads yesterday to
-- decide today.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS re_daily_release (
  release_date     date PRIMARY KEY,
  target_dials     int NOT NULL,
  actual_pushed    int NOT NULL DEFAULT 0,
  throttle_state   text NOT NULL DEFAULT 'green'
    CHECK (throttle_state IN ('green','yellow','red')),
  throttle_reason  text,
  -- metrics measured for THIS day, written by the nightly rollup
  rollover_pct     numeric,
  answer_rate      numeric,
  optout_rate      numeric,
  reached_count    int,
  appointment_count int,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);


-- ------------------------------------------------------------
-- Caller ID pool, for reputation rotation (plan §7).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS re_caller_number (
  phone_e164     text PRIMARY KEY,
  label          text,
  daily_cap      int NOT NULL DEFAULT 110,
  active         boolean NOT NULL DEFAULT true,
  retired_at     timestamptz,
  retired_reason text,
  created_at     timestamptz NOT NULL DEFAULT now()
);


-- ============================================================
-- Views for the dashboard
-- ============================================================

-- Live funnel by cohort. Drop this straight into the dashboard.
CREATE OR REPLACE VIEW re_v_cohort_status AS
SELECT
  c.wave,
  c.code AS cohort,
  c.label,
  count(*) FILTER (WHERE ct.status = 'eligible')      AS waiting,
  count(*) FILTER (WHERE ct.status = 'in_flight')     AS in_flight,
  count(*) FILTER (WHERE ct.status = 'reached')       AS reached,
  count(*) FILTER (WHERE ct.status = 'appointment')   AS appointments,
  count(*) FILTER (WHERE ct.status = 'exhausted')     AS exhausted,
  count(*) FILTER (WHERE ct.status = 'opted_out')     AS opted_out,
  count(*) FILTER (WHERE ct.status = 'invalid_phone') AS bad_numbers,
  count(ct.id)                                        AS total,
  round(100.0 * count(*) FILTER (WHERE ct.status IN ('reached','appointment'))
        / nullif(count(*) FILTER (WHERE ct.status <> 'eligible'), 0), 1) AS reach_pct_of_worked
FROM re_cohort c
LEFT JOIN re_contact ct ON ct.cohort_code = c.code
GROUP BY c.wave, c.code, c.label
ORDER BY c.wave, c.code;


-- Real answer rate by attempt number and window.
-- This is the table that tells you whether the rotating ladder
-- is actually working. Compare window_label performance.
CREATE OR REPLACE VIEW re_v_window_performance AS
SELECT
  window_label,
  attempt_number,
  count(*)                                                       AS attempts,
  count(*) FILTER (WHERE outcome IN ('reached','appointment'))    AS connects,
  round(100.0 * count(*) FILTER (WHERE outcome IN ('reached','appointment'))
        / nullif(count(*), 0), 2)                                AS answer_rate_pct
FROM re_attempt
WHERE outcome IS NOT NULL
GROUP BY window_label, attempt_number
ORDER BY window_label, attempt_number;


-- Caller-ID health. Watch for a number's answer rate falling
-- >30% below the pool median — that number is getting flagged.
CREATE OR REPLACE VIEW re_v_number_health AS
WITH per_number AS (
  SELECT
    from_number,
    count(*) AS dials_7d,
    round(100.0 * count(*) FILTER (WHERE outcome IN ('reached','appointment'))
          / nullif(count(*), 0), 2) AS answer_rate_pct
  FROM re_attempt
  WHERE pushed_at > now() - interval '7 days'
    AND from_number IS NOT NULL
  GROUP BY from_number
),
-- percentile_cont returns double precision; round(double, int) does not exist
-- in Postgres, so the median is cast to numeric before rounding.
median AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY answer_rate_pct)::numeric AS med
  FROM per_number
)
SELECT
  p.*,
  round(m.med, 2) AS pool_median_pct,
  CASE
    WHEN m.med IS NOT NULL AND p.answer_rate_pct < 0.7 * m.med THEN 'RETIRE'
    ELSE 'ok'
  END AS recommendation
FROM per_number p
CROSS JOIN median m
ORDER BY p.answer_rate_pct;

COMMIT;
