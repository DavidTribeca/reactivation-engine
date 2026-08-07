-- ============================================================
-- Flow-control and tracking views.
--
-- Answers "how much is in the system right now, and what's coming?"
-- ============================================================

BEGIN;

-- The live work-in-progress picture. This is the single most useful query
-- for answering "how many calls are in the system at once".
CREATE OR REPLACE VIEW re_v_flow AS
SELECT
  (SELECT count(*) FROM re_contact WHERE status = 'in_flight')                     AS in_flight_now,
  (SELECT count(*) FROM re_contact
    WHERE status = 'eligible' AND next_eligible_at <= now())                       AS due_now,
  (SELECT count(*) FROM re_contact
    WHERE status = 'eligible' AND next_eligible_at > now())                        AS scheduled_later,
  (SELECT count(*) FROM re_contact
    WHERE status = 'eligible'
      AND next_eligible_at::date = current_date)                                   AS due_today,
  (SELECT count(*) FROM re_contact
    WHERE status = 'eligible'
      AND next_eligible_at::date = current_date + 1)                               AS due_tomorrow,
  (SELECT count(*) FROM re_attempt
    WHERE pushed_at::date = current_date AND push_ok)                              AS pushed_today,
  (SELECT target_dials FROM re_daily_release WHERE release_date = current_date)    AS target_today,
  (SELECT throttle_state FROM re_daily_release WHERE release_date = current_date)  AS throttle_state,
  (SELECT count(*) FROM re_contact WHERE status = 'reached')                       AS reached_total,
  (SELECT count(*) FROM re_contact WHERE status = 'appointment')                   AS appointments_total,
  (SELECT count(*) FROM re_contact WHERE status = 'exhausted')                     AS exhausted_total,
  (SELECT count(*) FROM re_contact WHERE status = 'suppressed')                    AS suppressed_total,
  (SELECT count(*) FROM re_contact WHERE status = 'opted_out')                     AS opted_out_total,
  (SELECT count(*) FROM re_contact)                                                AS total_in_program,
  (SELECT last_ok_at FROM re_sync_state WHERE key = 'suppression')                 AS suppression_last_ok,
  re_suppression_is_fresh(120)                                                     AS suppression_fresh;


-- Per-window pacing for today: is the day's volume spreading properly, or
-- piling into one window?
CREATE OR REPLACE VIEW re_v_today_by_window AS
SELECT
  window_label,
  count(*)                                                     AS pushed,
  count(*) FILTER (WHERE outcome IS NULL)                      AS awaiting_outcome,
  count(*) FILTER (WHERE outcome IN ('reached','appointment')) AS connects,
  count(*) FILTER (WHERE NOT push_ok)                          AS push_failures
FROM re_attempt
WHERE pushed_at::date = current_date
GROUP BY window_label
ORDER BY window_label;


-- Forward load: how many dials are already committed to each future day by the
-- retry ladder, before any new contacts are introduced. Tells you whether an
-- upcoming day is already full of retries.
CREATE OR REPLACE VIEW re_v_forward_load AS
SELECT
  next_eligible_at::date AS day,
  count(*)               AS scheduled_retries,
  count(*) FILTER (WHERE attempt_count = 1) AS attempt_2,
  count(*) FILTER (WHERE attempt_count = 2) AS attempt_3,
  count(*) FILTER (WHERE attempt_count = 3) AS attempt_4,
  count(*) FILTER (WHERE attempt_count = 4) AS attempt_5
FROM re_contact
WHERE status = 'eligible' AND next_eligible_at > now()
GROUP BY 1
ORDER BY 1
LIMIT 30;


-- Program burn-down: how much of the target set is worked, and the rate.
CREATE OR REPLACE VIEW re_v_burndown AS
WITH d AS (
  SELECT
    count(*)                                                          AS total,
    count(*) FILTER (WHERE status IN ('eligible'))                    AS remaining,
    count(*) FILTER (WHERE status NOT IN ('eligible','in_flight'))    AS resolved
  FROM re_contact
), r AS (
  SELECT count(DISTINCT contact_id)::numeric
         / nullif(count(DISTINCT pushed_at::date), 0) AS contacts_per_day
  FROM re_attempt
  WHERE pushed_at > now() - interval '14 days' AND push_ok
)
SELECT
  d.total, d.remaining, d.resolved,
  round(100.0 * d.resolved / nullif(d.total, 0), 1)          AS pct_complete,
  round(r.contacts_per_day, 1)                               AS contacts_per_day_14d,
  CASE WHEN r.contacts_per_day > 0
       THEN ceil(d.remaining / r.contacts_per_day / 26.0)
  END                                                        AS est_months_remaining
FROM d, r;

COMMIT;
