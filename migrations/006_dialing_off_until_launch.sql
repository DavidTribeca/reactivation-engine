-- ============================================================
-- Correct the initial state of the dialing master switch.
--
-- Migration 004 created re_control and seeded dialing_enabled = 'true'.
-- re_dialing_enabled() is fail-closed for a MISSING row, but a row seeded
-- 'true' means every fresh deploy arrives armed — the opposite of what the
-- launch sequence assumes, where dialing stays off through the import, the
-- dry run and the deliberate stale-suppression test.
--
-- 004 now seeds 'false'. This migration fixes any database created before
-- that change.
--
-- IT WILL NOT HALT A RUNNING PROGRAM. The update only applies where no dial
-- has ever been recorded. Once re_attempt has rows the program is live, and
-- silently disabling dialing on a routine deploy would be its own nasty
-- surprise — exactly the class of thing this file exists to prevent.
-- ============================================================

BEGIN;

UPDATE re_control
   SET value = 'false',
       note = 'master switch — off until launch; run-dispatch.js resume to enable',
       updated_at = now(),
       updated_by = 'migration_006'
 WHERE key = 'dialing_enabled'
   AND value = 'true'
   AND NOT EXISTS (SELECT 1 FROM re_attempt);

COMMIT;
