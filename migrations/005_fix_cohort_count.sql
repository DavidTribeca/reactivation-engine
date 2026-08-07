-- ============================================================
-- Fix: re_v_cohort_status counted the cohort row itself.
--
-- The view LEFT JOINs re_cohort to re_contact and used count(*), which
-- returns 1 for a cohort with no contacts — so an empty cohort displayed as
-- "total 1, 100% worked" on the status page. count(ct.id) counts only real
-- contacts and returns 0 as it should.
--
-- Idempotent; safe whether or not 001 has already been applied.
-- ============================================================

BEGIN;

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
        / nullif(count(*) FILTER (WHERE ct.id IS NOT NULL AND ct.status <> 'eligible'), 0), 1)
                                                      AS reach_pct_of_worked
FROM re_cohort c
LEFT JOIN re_contact ct ON ct.cohort_code = c.code
GROUP BY c.wave, c.code, c.label
ORDER BY c.wave, c.code;

COMMIT;
