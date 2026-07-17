import { getDb } from '../db';
import { fromHHMM, toHHMM, WindowPattern } from './windowDetector';

/** Rolling window length enforced by Claude Code and Codex CLI. */
const WINDOW_MINUTES = 300;
/** Fire slightly early so the reset lands just BEFORE typical exhaustion. */
const SAFETY_MARGIN_MINUTES = 5;
/** Don't move an already-scheduled prewarm for drifts smaller than this. */
const HYSTERESIS_MINUTES = 5;
/** Need at least this much observed dead zone for prewarm to be worth it. */
const MIN_DEAD_ZONE_MINUTES = 20;
const MIN_CONFIDENCE = 0.4;

export interface PrewarmDecision {
  worthEnabling: boolean;
  proposedLocalTime: string | null; // "HH:MM"
  reason: string;
}

/**
 * The core trick: the rolling window starts at your FIRST prompt. If you
 * naturally start at 09:00 and exhaust at 12:10, you're locked out until 14:00.
 * Fire a trivial prompt at (exhaustion - 5h - margin) = 07:05 instead, and the
 * window you actually burn through resets at ~12:05 — just before you'd have
 * hit the wall. The dead zone collapses.
 */
export function computePrewarm(pattern: WindowPattern): PrewarmDecision {
  if (pattern.windowExhaustionLocal == null) {
    return {
      worthEnabling: false,
      proposedLocalTime: null,
      reason: `No rate-limit events observed yet for ${pattern.tool} (need ~5 days that hit the limit).`,
    };
  }
  if (pattern.confidence < MIN_CONFIDENCE) {
    return {
      worthEnabling: false,
      proposedLocalTime: null,
      reason: `Only ${pattern.sampleDays} day(s) of exhaustion data — pattern not stable enough yet.`,
    };
  }
  if ((pattern.deadZoneMinutes ?? 0) < MIN_DEAD_ZONE_MINUTES) {
    return {
      worthEnabling: false,
      proposedLocalTime: null,
      reason: `Observed dead zone is only ~${pattern.deadZoneMinutes ?? 0} min — prewarm wouldn't buy much.`,
    };
  }

  const exhaustionMin = fromHHMM(pattern.windowExhaustionLocal);
  const prewarmMin = exhaustionMin - WINDOW_MINUTES - SAFETY_MARGIN_MINUTES;
  return {
    worthEnabling: true,
    proposedLocalTime: toHHMM(prewarmMin),
    reason:
      `Typical exhaustion ${pattern.windowExhaustionLocal}, dead zone ~${pattern.deadZoneMinutes} min. ` +
      `Prewarm at ${toHHMM(prewarmMin)} shifts your window reset to ~${toHHMM(prewarmMin + WINDOW_MINUTES)}, ` +
      `landing just before you'd normally hit the wall.`,
  };
}

export interface PrewarmConfigRow {
  tool: string;
  enabled: number;
  scheduled_local_time: string | null;
  manual_override: number;
  last_fired_at: string | null;
}

export function getPrewarmConfig(tool: 'claude' | 'codex'): PrewarmConfigRow | undefined {
  return getDb().prepare('SELECT * FROM prewarm_config WHERE tool = ?').get(tool) as
    | PrewarmConfigRow
    | undefined;
}

export function setPrewarmConfig(
  tool: 'claude' | 'codex',
  fields: { enabled?: boolean; scheduledLocalTime?: string | null; manualOverride?: boolean; lastFiredAt?: string }
): void {
  const existing = getPrewarmConfig(tool);
  const enabled = fields.enabled ?? (existing ? existing.enabled === 1 : false);
  const time =
    fields.scheduledLocalTime !== undefined
      ? fields.scheduledLocalTime
      : (existing?.scheduled_local_time ?? null);
  const manual = fields.manualOverride ?? (existing ? existing.manual_override === 1 : false);
  const lastFired = fields.lastFiredAt ?? existing?.last_fired_at ?? null;
  getDb()
    .prepare(
      `INSERT INTO prewarm_config (tool, enabled, scheduled_local_time, manual_override, last_fired_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(tool) DO UPDATE SET enabled = excluded.enabled,
         scheduled_local_time = excluded.scheduled_local_time,
         manual_override = excluded.manual_override,
         last_fired_at = excluded.last_fired_at,
         updated_at = datetime('now')`
    )
    .run(tool, enabled ? 1 : 0, time, manual ? 1 : 0, lastFired);
}

/**
 * Convergence step, run periodically by the daemon: if the learned pattern has
 * drifted, move the scheduled prewarm time — but only past a hysteresis
 * threshold, so day-to-day noise doesn't jitter the schedule.
 */
export function reconcilePrewarmTime(
  tool: 'claude' | 'codex',
  decision: PrewarmDecision
): { changed: boolean; from: string | null; to: string | null } {
  const cfg = getPrewarmConfig(tool);
  if (!cfg || cfg.enabled !== 1 || cfg.manual_override === 1) {
    return { changed: false, from: cfg?.scheduled_local_time ?? null, to: cfg?.scheduled_local_time ?? null };
  }
  if (!decision.worthEnabling || !decision.proposedLocalTime) {
    return { changed: false, from: cfg.scheduled_local_time, to: cfg.scheduled_local_time };
  }
  const current = cfg.scheduled_local_time;
  if (
    current == null ||
    Math.abs(fromHHMM(current) - fromHHMM(decision.proposedLocalTime)) > HYSTERESIS_MINUTES
  ) {
    setPrewarmConfig(tool, { scheduledLocalTime: decision.proposedLocalTime });
    return { changed: true, from: current, to: decision.proposedLocalTime };
  }
  return { changed: false, from: current, to: current };
}
