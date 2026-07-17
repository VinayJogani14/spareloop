import { CliAdapter, isRollingWindowAdapter, ToolName } from '../../adapters/types';
import { latestRateLimit } from '../repo';
import { latestPattern, fromHHMM, minutesOfDay } from '../patterns/windowDetector';
import { kvGet } from '../db';
import { coolOffMsForUnparseableReset } from '../../adapters/resetParser';

export type Capacity = 'available' | 'blocked' | 'likely_dead_zone';

export interface CapacityVerdict {
  capacity: Capacity;
  reason: string;
  blockedUntil?: Date;
}

const PATTERN_CONFIDENCE_GATE = 0.5;

/**
 * Decide whether a tool likely has spare capacity right now.
 *
 * Neither Claude Code nor Codex exposes a live quota API, so this layers:
 *  1. Reactive (hard): a recent rate-limit hit whose reset is still in the
 *     future -> blocked. This is ground truth.
 *  2. Heuristic (soft): current local time falls inside the historically
 *     observed exhaustion->reset dead zone -> likely_dead_zone. Probabilistic.
 *  3. Cold start: no data -> optimistic, rely on reactive handling + retries.
 *
 * Cursor has no rolling window at all: always available unless manually paused.
 */
export function assessCapacity(adapter: CliAdapter, now = new Date()): CapacityVerdict {
  if (isPaused(adapter.tool)) {
    return { capacity: 'blocked', reason: `${adapter.tool} tasks manually paused` };
  }

  if (!isRollingWindowAdapter(adapter)) {
    return { capacity: 'available', reason: 'no rolling window (monthly credit pool)' };
  }

  const lastHit = latestRateLimit(adapter.tool);
  if (lastHit?.rate_limit_reset_at) {
    const resetAt = new Date(lastHit.rate_limit_reset_at);
    if (!isNaN(resetAt.getTime()) && resetAt > now) {
      return {
        capacity: 'blocked',
        reason: `rate limit hit at ${lastHit.occurred_at}, resets ${resetAt.toLocaleTimeString()}`,
        blockedUntil: resetAt,
      };
    }
  } else if (lastHit) {
    // Rate limit hit but reset time unparseable: conservative fixed cool-off,
    // longer when the message indicates a weekly cap rather than a window hit.
    const hitTime = new Date(lastHit.occurred_at);
    const coolOffMs = coolOffMsForUnparseableReset(lastHit.raw_ref ?? '');
    const coolOffUntil = new Date(hitTime.getTime() + coolOffMs);
    if (coolOffUntil > now) {
      return {
        capacity: 'blocked',
        reason: `recent rate limit with unparseable reset time; ${Math.round(coolOffMs / 3600000)}h cool-off`,
        blockedUntil: coolOffUntil,
      };
    }
  }

  // Scoped to the default login specifically (latestPattern's account param
  // defaults to null) - blending multiple accounts' independent rhythms into
  // one pattern would never be meaningful. Per-account nuance matters most
  // for prewarm (see prewarmComputer.ts), which IS fully per-account; this
  // general pre-routing gate stays keyed to the default login as a
  // deliberate scope boundary, since the target account for 'auto'-routed
  // tasks isn't resolved until after this check.
  const pattern = latestPattern(adapter.tool);
  if (
    pattern &&
    pattern.confidence >= PATTERN_CONFIDENCE_GATE &&
    pattern.windowExhaustionLocal &&
    pattern.windowResetLocal
  ) {
    const nowMin = minutesOfDay(now);
    const exhaust = fromHHMM(pattern.windowExhaustionLocal);
    const reset = fromHHMM(pattern.windowResetLocal);
    if (exhaust < reset && nowMin >= exhaust && nowMin < reset) {
      return {
        capacity: 'likely_dead_zone',
        reason: `inside historical dead zone ${pattern.windowExhaustionLocal}-${pattern.windowResetLocal} (confidence ${pattern.confidence.toFixed(2)})`,
      };
    }
  }

  return { capacity: 'available', reason: 'no blocking signal' };
}

export function isPaused(tool: ToolName): boolean {
  return kvGet(`paused:${tool}`) === '1';
}
