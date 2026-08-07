-- ============================================================
-- Safety controls
--   1. Emergency stop      — halt all dialing instantly, no Railway access
--   2. Timezone provenance — know which contacts we can actually place
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Operator control flags. The dispatcher reads dialing_enabled
--    before doing anything else.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS re_control (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

INSERT INTO re_control (key, value, note, updated_by)
VALUES ('dialing_enabled', 'true', 'master switch — set false to halt all dialing', 'migration')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION re_dialing_enabled() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT value = 'true' FROM re_control WHERE key = 'dialing_enabled'), false)
$$;

-- Note the COALESCE default: if the row is missing entirely, dialing is OFF.
-- A control table that fails to load must never mean "dial freely".


-- ------------------------------------------------------------
-- 2. Timezone provenance.
--
-- The dial-window check enforces 8am-8pm in the CONTACT's local time, which is
-- only meaningful if that timezone is correct. Every record previously
-- inherited the America/Los_Angeles default, so an East Coast contact hit the
-- 6-8pm Pacific window at 9-11pm local — past the federal 9pm cutoff.
--
-- tz_source records how we know. 'default_unknown' rows are restricted to the
-- mid-morning window, which is inside legal hours across the continental US
-- no matter where the person actually is.
-- ------------------------------------------------------------
ALTER TABLE re_contact
  ADD COLUMN IF NOT EXISTS tz_source text NOT NULL DEFAULT 'default_unknown';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 're_contact_tz_source_chk') THEN
    ALTER TABLE re_contact ADD CONSTRAINT re_contact_tz_source_chk
      CHECK (tz_source IN ('address_state', 'area_code', 'default_unknown'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS re_contact_tz_source_idx ON re_contact (tz_source);


-- How much of the queue can we actually place? The health check watches this.
CREATE OR REPLACE VIEW re_v_timezone_coverage AS
SELECT
  tz_source,
  timezone,
  count(*)                                                       AS contacts,
  round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1)  AS pct
FROM re_contact
GROUP BY tz_source, timezone
ORDER BY contacts DESC;

COMMIT;
