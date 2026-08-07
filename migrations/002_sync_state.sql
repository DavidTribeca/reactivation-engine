-- ============================================================
-- Sync state + suppression freshness guard
--
-- Counsel cleared dialing everything outside the FUB "do not contact" pond.
-- That makes the pond sync a SAFETY-CRITICAL dependency: if it stops running,
-- the dispatcher would keep dialing people who have since asked not to be
-- called. This table lets the dispatcher check the sync is fresh and refuse to
-- dial if it is not.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS re_sync_state (
  key          text PRIMARY KEY,
  last_run_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz,
  ok           boolean NOT NULL DEFAULT true,
  detail       text
);

INSERT INTO re_sync_state (key, last_run_at, last_ok_at, ok, detail)
VALUES ('suppression', now() - interval '99 hours', NULL, false, 'never run')
ON CONFLICT (key) DO NOTHING;

-- Convenience: is suppression fresh enough to dial?
CREATE OR REPLACE FUNCTION re_suppression_is_fresh(max_age_minutes int DEFAULT 120)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT last_ok_at > now() - (max_age_minutes || ' minutes')::interval
       FROM re_sync_state WHERE key = 'suppression'),
    false)
$$;

COMMIT;
