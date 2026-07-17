import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { usageEventsSince, UsageEventRow } from '../repo';
import { ToolName } from '../../adapters/types';

export interface DailyObservation {
  day: string; // YYYY-MM-DD local
  windowStartMin: number; // minutes since local midnight of first event
  exhaustionMin: number | null; // minutes of first rate-limit hit that day
  resetMin: number | null; // minutes of parsed reset time
  weight: number; // recency weight
}

export interface WindowPattern {
  id: string;
  tool: ToolName;
  /** null = default (non-spareloop-managed) login; a name = that registered account. */
  account: string | null;
  windowStartLocal: string | null;
  windowExhaustionLocal: string | null;
  windowResetLocal: string | null;
  deadZoneMinutes: number | null;
  confidence: number;
  sampleDays: number;
  observations: DailyObservation[];
}

const LOOKBACK_DAYS = 21;
const RECENCY_HALF_LIFE_DAYS = 7;

/**
 * Reconstruct the typical daily rolling-window rhythm from usage events, for
 * ONE login (the default login, or one registered account) — each has its
 * own independent 5-hour window and rhythm, so patterns must never be
 * blended across accounts.
 *
 * Ground truth is explicit rate-limit-hit events — the one unambiguous signal.
 * Aggregation uses a recency-weighted median so old habits fade over ~2-4 weeks
 * and single outlier days don't drag the estimate.
 */
export function detectDailyWindow(
  tool: ToolName,
  now = new Date(),
  account: string | null = null
): WindowPattern {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000);
  const events = usageEventsSince(tool, since.toISOString()).filter(
    (e) => (e.account ?? null) === account
  );

  const byDay = new Map<string, UsageEventRow[]>();
  for (const e of events) {
    const d = new Date(e.occurred_at);
    if (isNaN(d.getTime())) continue;
    const key = localDayKey(d);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(e);
  }

  const observations: DailyObservation[] = [];
  for (const [day, dayEvents] of byDay) {
    const first = new Date(dayEvents[0].occurred_at);
    const rl = dayEvents.find((e) => e.rate_limit_hit === 1);
    const ageDays = (now.getTime() - first.getTime()) / (24 * 3600 * 1000);
    observations.push({
      day,
      windowStartMin: minutesOfDay(first),
      exhaustionMin: rl ? minutesOfDay(new Date(rl.occurred_at)) : null,
      resetMin:
        rl?.rate_limit_reset_at != null ? minutesOfDay(new Date(rl.rate_limit_reset_at)) : null,
      weight: Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS),
    });
  }

  const exhaustDays = observations.filter((o) => o.exhaustionMin != null);
  const startMin = weightedMedian(observations.map((o) => [o.windowStartMin, o.weight]));
  const exhaustionMin = weightedMedian(
    exhaustDays.map((o) => [o.exhaustionMin as number, o.weight])
  );
  const resetDays = exhaustDays.filter((o) => o.resetMin != null);
  // If reset times were parseable use them; otherwise infer reset = window start + 5h.
  const resetMin =
    resetDays.length > 0
      ? weightedMedian(resetDays.map((o) => [o.resetMin as number, o.weight]))
      : startMin != null
        ? startMin + 300
        : null;

  const deadZone =
    exhaustionMin != null && resetMin != null ? Math.max(0, Math.round(resetMin - exhaustionMin)) : null;

  const confidence = Math.min(1, exhaustDays.length / 5);

  const pattern: WindowPattern = {
    id: randomUUID(),
    tool,
    account,
    windowStartLocal: startMin != null ? toHHMM(startMin) : null,
    windowExhaustionLocal: exhaustionMin != null ? toHHMM(exhaustionMin) : null,
    windowResetLocal: resetMin != null ? toHHMM(resetMin) : null,
    deadZoneMinutes: deadZone,
    confidence,
    sampleDays: exhaustDays.length,
    observations,
  };

  persist(pattern);
  return pattern;
}

export function latestPattern(tool: ToolName, account: string | null = null): WindowPattern | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM learned_patterns WHERE tool = ? AND pattern_type = 'daily_window'
       AND account IS ? ORDER BY computed_at DESC LIMIT 1`
    )
    .get(tool, account) as any;
  if (!row) return null;
  return {
    id: row.id,
    tool: row.tool,
    account: row.account,
    windowStartLocal: row.window_start_local,
    windowExhaustionLocal: row.window_exhaustion_local,
    windowResetLocal: row.window_reset_local,
    deadZoneMinutes: row.dead_zone_minutes,
    confidence: row.confidence,
    sampleDays: row.sample_days,
    observations: row.details_json ? JSON.parse(row.details_json) : [],
  };
}

function persist(p: WindowPattern): void {
  getDb()
    .prepare(
      `INSERT INTO learned_patterns (id, tool, account, pattern_type, window_start_local,
         window_exhaustion_local, window_reset_local, dead_zone_minutes, confidence,
         sample_days, lookback_days, details_json)
       VALUES (?, ?, ?, 'daily_window', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      p.id,
      p.tool,
      p.account,
      p.windowStartLocal,
      p.windowExhaustionLocal,
      p.windowResetLocal,
      p.deadZoneMinutes,
      p.confidence,
      p.sampleDays,
      LOOKBACK_DAYS,
      JSON.stringify(p.observations)
    );
}

export function weightedMedian(pairs: Array<[number, number]>): number | null {
  if (pairs.length === 0) return null;
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const totalWeight = sorted.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [value, weight] of sorted) {
    acc += weight;
    if (acc >= totalWeight / 2) return value;
  }
  return sorted[sorted.length - 1][0];
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function toHHMM(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function fromHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
