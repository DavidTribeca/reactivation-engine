/**
 * Throttle — decides HOW MANY dials to release today.
 *
 * Scales on evidence, not on a calendar. The primary signal is rollover: the
 * share of escalated bot conversations that no human followed up on. Your logs
 * showed 36%-109% rollover on busy days at ~1/10th of target volume, so this
 * is the constraint that actually governs the program.
 *
 * Three diseases, three different signals:
 *   rollover up      -> human capacity problem
 *   answer rate down -> caller-ID reputation problem
 *   opt-outs up      -> targeting or script problem
 *
 * DESIGN NOTE — why this takes COUNTS, not rates.
 * An earlier version evaluated single-day rates. Simulation showed that at
 * ~10 connects/day a single opt-out reads as a 10% opt-out rate and slams the
 * program to red, pinning volume at the floor forever. Rates computed on small
 * denominators are pure noise. So: all signals are trailing 7-day COUNTS, and
 * each signal is ignored until its denominator clears a minimum sample size.
 */

export const THRESHOLDS = {
  rollover:   { green: 0.05, red: 0.15 },
  answerDrop: { green: 0.15, red: 0.30 },
  optOut:     { green: 0.01, red: 0.02 },
};

/**
 * Minimum denominator before a signal is allowed to influence the decision.
 * Below these, the signal reports 'insufficient_data' and is skipped.
 */
export const MIN_SAMPLE = {
  resolvedForAnswerRate: 150,   // ~1.5 days at 100/day
  connectsForOptOut:     50,    // one opt-out in 50 = 2%, the red line
  escalationsForRollover: 10,
};

export const RAMP = {
  // ── WHY THIS IS NOT 100 ────────────────────────────────────────────────
  //
  // It was. With floor 100 and redCutPct 0.50, nextTarget(100, red) returns
  // max(100, 50) = 100 — a red verdict at the starting cap is a no-op, and the
  // program cannot throttle itself down at the only volume it has ever run at.
  // That is visible in the 19-20 Aug 2026 logs: two consecutive RED days on a
  // collapsing answer rate, target unchanged at 100 both times.
  //
  // A floor is meant to stop the ramp winding down to nothing, not to outrank
  // the emergency brake. 25 leaves the brake two full cuts of room (100 -> 50
  // -> 25) before it bottoms out.
  floor:          Number(process.env.RE_RAMP_FLOOR || 25),
  ceiling:        750,
  greenStepPct:   0.25,
  redCutPct:      0.50,
  consecutiveGreenDaysRequired: 5,
};

/**
 * @param {object} m trailing-7-day counts
 * @param {number} m.escalations7d  conversations handed to an ISA
 * @param {number} m.leaked7d       of those, left uncalled (your rollover log)
 * @param {number} m.resolved7d     attempts with a known outcome
 * @param {number} m.connects7d     attempts that reached a live person
 * @param {number} m.optOuts7d      explicit opt-outs
 * @param {number} m.baselineAnswerRate  trailing 28-day baseline, 0..1
 * @param {number} m.consecutiveGreenDays
 */
export function evaluate(m) {
  const reasons = [];
  const signals = {};
  let state = 'green';

  const bump = (next, why) => {
    reasons.push(why);
    if (next === 'red') state = 'red';
    else if (state !== 'red') state = 'yellow';
  };

  // --- rollover: human capacity ---
  if (m.escalations7d >= MIN_SAMPLE.escalationsForRollover) {
    const rollover = m.leaked7d / m.escalations7d;
    signals.rollover = rollover;
    if (rollover >= THRESHOLDS.rollover.red) {
      bump('red', `rollover ${pct(rollover)} over 7d — ISA follow-up cannot absorb current volume`);
    } else if (rollover > THRESHOLDS.rollover.green) {
      bump('yellow', `rollover ${pct(rollover)} above ${pct(THRESHOLDS.rollover.green)} target`);
    }
  } else {
    signals.rollover = null;
    reasons.push(`rollover: insufficient data (${m.escalations7d} escalations)`);
  }

  // --- answer rate: number reputation ---
  if (m.resolved7d >= MIN_SAMPLE.resolvedForAnswerRate && m.baselineAnswerRate > 0) {
    const answerRate = m.connects7d / m.resolved7d;
    const drop = (m.baselineAnswerRate - answerRate) / m.baselineAnswerRate;
    signals.answerRate = answerRate;
    signals.answerDrop = drop;
    if (drop >= THRESHOLDS.answerDrop.red) {
      bump('red', `answer rate down ${pct(drop)} vs baseline — likely caller-ID flagging, check re_v_number_health`);
    } else if (drop > THRESHOLDS.answerDrop.green) {
      bump('yellow', `answer rate down ${pct(drop)} vs baseline`);
    }
  } else {
    signals.answerRate = null;
    reasons.push(`answer rate: insufficient data (${m.resolved7d} resolved)`);
  }

  // --- opt-outs: targeting / script ---
  if (m.connects7d >= MIN_SAMPLE.connectsForOptOut) {
    const optOutRate = m.optOuts7d / m.connects7d;
    signals.optOutRate = optOutRate;
    if (optOutRate >= THRESHOLDS.optOut.red) {
      bump('red', `opt-out rate ${pct(optOutRate)} over 7d — stop and review script/targeting`);
    } else if (optOutRate > THRESHOLDS.optOut.green) {
      bump('yellow', `opt-out rate ${pct(optOutRate)} above ${pct(THRESHOLDS.optOut.green)}`);
    }
  } else {
    signals.optOutRate = null;
    reasons.push(`opt-out rate: insufficient data (${m.connects7d} connects)`);
  }

  const earnedIncrease =
    state === 'green' && m.consecutiveGreenDays >= RAMP.consecutiveGreenDaysRequired;

  if (state === 'green' && !earnedIncrease) {
    reasons.push(`healthy but ${m.consecutiveGreenDays}/${RAMP.consecutiveGreenDaysRequired} clean days — holding`);
  }

  return { state, reasons, signals, earnedIncrease };
}

/** Today's dial target given yesterday's target and the verdict. */
export function nextTarget(currentTarget, verdict) {
  if (verdict.state === 'red') {
    return Math.max(RAMP.floor, Math.floor(currentTarget * (1 - RAMP.redCutPct)));
  }
  if (verdict.earnedIncrease) {
    return Math.min(RAMP.ceiling, Math.ceil(currentTarget * (1 + RAMP.greenStepPct)));
  }
  return currentTarget;
}

function pct(x) { return `${(x * 100).toFixed(1)}%`; }
