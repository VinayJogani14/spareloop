import { ToolName } from '../../adapters/types';
import { usageEventsSince, UsageEventRow } from '../repo';
import { weightedMedian } from './windowDetector';

const LOOKBACK_DAYS = 21;
const RECENCY_HALF_LIFE_DAYS = 7;
/** Burn rate computed over this trailing slice of the active window, not the whole window. */
const BURN_RATE_TRAILING_MIN = 45;

export interface WindowSnapshot {
  windowStartAt: Date;
  elapsedMin: number;
  cumulativeTokens: number;
  cumulativeCostUsd: number | null;
  burnTokensPerMin: number;
}

/**
 * Reconstruct "today's active window" from the unified usage timeline: starts
 * at the first event after the most recent rate-limit reset that has already
 * passed, or the first event of the local day if no reset applies. Same
 * boundary logic as pattern learning, just scoped to right now.
 */
export function currentWindowSnapshot(
  tool: ToolName,
  now: Date,
  account?: string | null
): WindowSnapshot | null {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  let events = usageEventsSince(tool, dayStart.toISOString()).filter((e) => new Date(e.occurred_at) <= now);
  if (account !== undefined) events = events.filter((e) => (e.account ?? null) === account);
  if (events.length === 0) return null;

  let boundary: Date | null = null;
  for (const e of events) {
    if (e.rate_limit_hit && e.rate_limit_reset_at) {
      const reset = new Date(e.rate_limit_reset_at);
      if (reset <= now && (!boundary || reset > boundary)) boundary = reset;
    }
  }
  const relevant = boundary ? events.filter((e) => new Date(e.occurred_at) >= boundary!) : events;
  if (relevant.length === 0) return null; // window reset already, nothing used yet

  const windowStartAt = new Date(relevant[0].occurred_at);
  const elapsedMin = Math.max(0.01, (now.getTime() - windowStartAt.getTime()) / 60000);
  const cumulativeTokens = relevant.reduce((s, e) => s + (e.input_tokens ?? 0) + (e.output_tokens ?? 0), 0);
  const cumulativeCostUsd = relevant.some((e) => e.cost_usd != null)
    ? relevant.reduce((s, e) => s + (e.cost_usd ?? 0), 0)
    : null;

  const trailingSince = new Date(now.getTime() - BURN_RATE_TRAILING_MIN * 60000);
  const trailing = relevant.filter((e) => new Date(e.occurred_at) >= trailingSince);
  const burnWindowMin = trailing.length > 0
    ? Math.max(1, (now.getTime() - new Date(trailing[0].occurred_at).getTime()) / 60000)
    : elapsedMin;
  const trailingTokens = trailing.reduce((s, e) => s + (e.input_tokens ?? 0) + (e.output_tokens ?? 0), 0);
  const burnTokensPerMin = trailing.length > 0 ? trailingTokens / burnWindowMin : cumulativeTokens / elapsedMin;

  return { windowStartAt, elapsedMin, cumulativeTokens, cumulativeCostUsd, burnTokensPerMin };
}

export interface ExhaustionBudget {
  medianTokens: number | null;
  sampleDays: number;
  confidence: number;
}

/**
 * From historical rate-limit-hit days, estimate the typical cumulative token
 * count consumed between a window's start and its exhaustion. This sidesteps
 * needing the vendor's actual (unexposed) quota: it's calibrated entirely
 * from the user's own past exhaustion events.
 */
export function computeExhaustionBudget(tool: ToolName, now: Date): ExhaustionBudget {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000);
  const events = usageEventsSince(tool, since.toISOString());

  const byDay = new Map<string, UsageEventRow[]>();
  for (const e of events) {
    const d = new Date(e.occurred_at);
    if (isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(e);
  }

  const budgets: Array<[number, number]> = []; // [tokens, weight]
  for (const dayEvents of byDay.values()) {
    const hitIdx = dayEvents.findIndex((e) => e.rate_limit_hit === 1);
    if (hitIdx === -1) continue;
    const windowStart = new Date(dayEvents[0].occurred_at);
    const hitAt = new Date(dayEvents[hitIdx].occurred_at);
    const tokens = dayEvents
      .slice(0, hitIdx + 1)
      .reduce((s, e) => s + (e.input_tokens ?? 0) + (e.output_tokens ?? 0), 0);
    const ageDays = (now.getTime() - hitAt.getTime()) / (24 * 3600 * 1000);
    if (tokens > 0) budgets.push([tokens, Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)]);
    void windowStart;
  }

  return {
    medianTokens: budgets.length > 0 ? weightedMedian(budgets) : null,
    sampleDays: budgets.length,
    confidence: Math.min(1, budgets.length / 5),
  };
}

export interface WindowPrediction {
  hasData: boolean;
  reason: string;
  etaMinutes: number | null;
  etaAt: string | null;
  confidence: number;
  percentOfTypicalBudget: number | null;
}

/** Live "when will I hit the wall" forecast for the current window. */
export function predictWindow(tool: ToolName, now = new Date(), account?: string | null): WindowPrediction {
  const snapshot = currentWindowSnapshot(tool, now, account);
  if (!snapshot) {
    return { hasData: false, reason: 'no usage yet in the current window', etaMinutes: null, etaAt: null, confidence: 0, percentOfTypicalBudget: null };
  }
  const budget = computeExhaustionBudget(tool, now);
  if (budget.medianTokens == null) {
    return {
      hasData: true,
      reason: `${Math.round(snapshot.elapsedMin)} min into the window, ~${Math.round(snapshot.cumulativeTokens)} tokens used; no historical rate-limit hits yet to calibrate an ETA`,
      etaMinutes: null,
      etaAt: null,
      confidence: 0,
      percentOfTypicalBudget: null,
    };
  }

  const percent = (snapshot.cumulativeTokens / budget.medianTokens) * 100;
  if (snapshot.cumulativeTokens >= budget.medianTokens) {
    return {
      hasData: true,
      reason: `already at ~${Math.round(percent)}% of your typical exhaustion point — the wall could hit any moment`,
      etaMinutes: 0,
      etaAt: now.toISOString(),
      confidence: budget.confidence,
      percentOfTypicalBudget: percent,
    };
  }
  if (snapshot.burnTokensPerMin <= 0) {
    return {
      hasData: true,
      reason: 'usage has stalled this window — no recent burn to extrapolate from',
      etaMinutes: null,
      etaAt: null,
      confidence: budget.confidence,
      percentOfTypicalBudget: percent,
    };
  }

  const remaining = budget.medianTokens - snapshot.cumulativeTokens;
  const etaMinutes = remaining / snapshot.burnTokensPerMin;
  const etaAt = new Date(now.getTime() + etaMinutes * 60000);
  return {
    hasData: true,
    reason: `at your current pace (~${Math.round(snapshot.burnTokensPerMin)} tok/min), you'll reach your typical exhaustion point in ~${Math.round(etaMinutes)} min`,
    etaMinutes,
    etaAt: etaAt.toISOString(),
    confidence: budget.confidence,
    percentOfTypicalBudget: percent,
  };
}

export interface WeeklyForecast {
  hasData: boolean;
  costUsdSoFar: number | null;
  tokensSoFar: number;
  fractionOfWeekElapsed: number;
  projectedWeekTokens: number | null;
  projectedWeekCostUsd: number | null;
}

/**
 * Coarse weekly-cap awareness: naive same-pace projection from the fraction
 * of the ISO week elapsed. Weekly hits are rare enough that a robust
 * exhaustion-budget model (like the window predictor) needs more history
 * than most users will have, so this stays intentionally simple and labeled
 * as a projection, not a calibrated ETA.
 */
export function predictWeekly(tool: ToolName, now = new Date()): WeeklyForecast {
  const weekStart = new Date(now);
  const isoDow = (weekStart.getDay() + 6) % 7; // Mon=0..Sun=6
  weekStart.setDate(weekStart.getDate() - isoDow);
  weekStart.setHours(0, 0, 0, 0);

  const events = usageEventsSince(tool, weekStart.toISOString());
  if (events.length === 0) {
    return { hasData: false, costUsdSoFar: null, tokensSoFar: 0, fractionOfWeekElapsed: 0, projectedWeekTokens: null, projectedWeekCostUsd: null };
  }
  const tokensSoFar = events.reduce((s, e) => s + (e.input_tokens ?? 0) + (e.output_tokens ?? 0), 0);
  const costUsdSoFar = events.some((e) => e.cost_usd != null) ? events.reduce((s, e) => s + (e.cost_usd ?? 0), 0) : null;
  const fraction = Math.min(1, Math.max(1 / (7 * 24 * 60), (now.getTime() - weekStart.getTime()) / (7 * 24 * 3600 * 1000)));

  return {
    hasData: true,
    costUsdSoFar,
    tokensSoFar,
    fractionOfWeekElapsed: fraction,
    projectedWeekTokens: tokensSoFar / fraction,
    projectedWeekCostUsd: costUsdSoFar != null ? costUsdSoFar / fraction : null,
  };
}
