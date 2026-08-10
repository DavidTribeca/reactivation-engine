-- ============================================================
-- Cycle tracking.
--
-- WHY THIS EXISTS: dials and people are not the same number, and every view
-- built so far reports dials. With a five-rung ladder each person absorbs
-- about 4.2 dials, so a 750-dial day introduces only ~180 NEW people to the
-- program. Reading "750" as "750 people reached today" overstates intake
-- roughly four-fold and would make the burndown look four times faster than
-- it is.
--
-- A first attempt (attempt_number = 1) is the moment a person enters the
-- cycle. Everything below counts people, not dials, and says which it is.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- Where every person stands relative to the cycle.
-- Three states that sum to the whole program, plus the exits.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW re_v_cycle AS
SELECT
  count(*)::int                                                        AS total_in_program,

  -- NOT YET ENTERED: loaded, never dialled. The reservoir.
  count(*) FILTER (WHERE attempt_count = 0
                     AND status = 'eligible')::int                     AS not_yet_entered,

  -- IN THE CYCLE: started the ladder, not finished with it.
  count(*) FILTER (WHERE attempt_count > 0
                     AND status IN ('eligible','in_flight'))::int       AS in_cycle,

  -- Of those, waiting on an outcome from a dial already placed.
  count(*) FILTER (WHERE status = 'in_flight')::int                     AS in_flight,

  -- Of those, due to be dialled again now.
  count(*) FILTER (WHERE attempt_count > 0 AND status = 'eligible'
                     AND next_eligible_at <= now())::int                AS due_now,

  -- LEFT THE CYCLE, split by how.
  count(*) FILTER (WHERE status = 'reached')::int                       AS left_reached,
  count(*) FILTER (WHERE status = 'appointment')::int                   AS left_appointment,
  count(*) FILTER (WHERE status = 'exhausted')::int                     AS left_exhausted,
  count(*) FILTER (WHERE status = 'opted_out')::int                     AS left_opted_out,
  count(*) FILTER (WHERE status = 'invalid_phone')::int                 AS left_bad_number,
  count(*) FILTER (WHERE status = 'suppressed')::int                    AS left_suppressed,
  count(*) FILTER (WHERE status IN ('reached','appointment','exhausted',
                                    'opted_out','invalid_phone','suppressed'))::int
                                                                        AS left_total
FROM re_contact;


-- ------------------------------------------------------------
-- Intake per day: NEW PEOPLE vs TOTAL DIALS, last 30 program days.
--
-- Both are counts, so they share one axis. The gap between the two lines IS
-- the retry load — it should sit near 4x once the ladder is full, and a gap
-- that stays near 1x means retries are not firing.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW re_v_intake_daily AS
WITH days AS (
  SELECT generate_series(current_date - 29, current_date, interval '1 day')::date AS d
)
SELECT
  days.d                                                               AS day,
  COALESCE(count(a.id) FILTER (WHERE a.attempt_number = 1), 0)::int     AS new_people,
  COALESCE(count(a.id), 0)::int                                        AS dials,
  COALESCE(count(a.id) FILTER (WHERE a.outcome IN ('reached','appointment')), 0)::int
                                                                       AS connects
FROM days
LEFT JOIN re_attempt a
       ON a.pushed_at::date = days.d
      AND a.push_ok
GROUP BY days.d
ORDER BY days.d;


-- ------------------------------------------------------------
-- How the in-cycle population is distributed across the ladder.
-- Answers "where is everyone" — bunching at rung 1 means retries are stalled.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW re_v_ladder_position AS
SELECT
  attempt_count                                                        AS attempts_made,
  count(*)::int                                                        AS people,
  count(*) FILTER (WHERE status = 'in_flight')::int                    AS awaiting_outcome,
  min(next_eligible_at)                                                AS next_due
FROM re_contact
WHERE attempt_count > 0
  AND status IN ('eligible','in_flight')
GROUP BY attempt_count
ORDER BY attempt_count;


-- ------------------------------------------------------------
-- Intake rate and what it implies for the finish date.
-- Keyed on PEOPLE entering, which is the only rate that predicts an end date.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW re_v_intake_rate AS
WITH r AS (
  SELECT
    count(*) FILTER (WHERE attempt_number = 1
                       AND pushed_at::date = current_date)::int         AS new_today,
    count(*) FILTER (WHERE attempt_number = 1
                       AND pushed_at > now() - interval '7 days')::int  AS new_7d,
    count(*) FILTER (WHERE attempt_number = 1
                       AND pushed_at > now() - interval '30 days')::int AS new_30d,
    count(*) FILTER (WHERE pushed_at::date = current_date AND push_ok)::int AS dials_today
  FROM re_attempt
),
res AS (
  SELECT count(*) FILTER (WHERE attempt_count = 0 AND status = 'eligible')::int AS remaining
  FROM re_contact
)
SELECT
  r.new_today, r.new_7d, r.new_30d, r.dials_today,
  res.remaining,
  round(r.new_7d / 7.0, 1)                                             AS new_per_day_7d,
  -- Dials consumed per person entering. ~4.2 when the ladder is running.
  CASE WHEN r.new_7d > 0
       THEN round((SELECT count(*) FROM re_attempt
                    WHERE pushed_at > now() - interval '7 days' AND push_ok)::numeric
                  / r.new_7d, 2) END                                   AS dials_per_person,
  -- Weeks to drain the reservoir at the trailing intake rate.
  CASE WHEN r.new_7d > 0
       THEN round(res.remaining / (r.new_7d / 7.0) / 7.0, 1) END        AS weeks_remaining
FROM r CROSS JOIN res;

COMMIT;
