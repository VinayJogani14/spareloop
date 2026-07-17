import { ToolName } from '../../adapters/types';
import { usageEventsSince } from '../repo';
import { latestPattern } from './windowDetector';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface HeatmapCell {
  isoDow: number; // 0=Mon..6=Sun
  hour: number; // 0-23
  events: number;
  tokens: number;
  costUsd: number;
}

export interface Heatmap {
  tool: ToolName;
  lookbackDays: number;
  cells: HeatmapCell[][]; // [isoDow][hour]
  peakHour: { isoDow: number; hour: number; tokens: number } | null;
  quietHours: number[]; // hours (0-23) with near-zero usage across the lookback, aggregated over all days
}

export function computeHeatmap(tool: ToolName, lookbackDays = 21, now = new Date()): Heatmap {
  const since = new Date(now.getTime() - lookbackDays * 24 * 3600 * 1000);
  const events = usageEventsSince(tool, since.toISOString());

  const cells: HeatmapCell[][] = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => ({ isoDow: d, hour: h, events: 0, tokens: 0, costUsd: 0 }))
  );

  for (const e of events) {
    const d = new Date(e.occurred_at);
    if (isNaN(d.getTime())) continue;
    const isoDow = (d.getDay() + 6) % 7;
    const cell = cells[isoDow][d.getHours()];
    cell.events += 1;
    cell.tokens += (e.input_tokens ?? 0) + (e.output_tokens ?? 0);
    cell.costUsd += e.cost_usd ?? 0;
  }

  const flat = cells.flat();
  const peak = flat.reduce((best, c) => (c.tokens > (best?.tokens ?? -1) ? c : best), null as HeatmapCell | null);

  const hourTotals = Array.from({ length: 24 }, (_, h) => cells.reduce((s, day) => s + day[h].tokens, 0));
  const maxHourTotal = Math.max(1, ...hourTotals);
  const quietHours = hourTotals
    .map((t, h) => ({ h, t }))
    .filter(({ t }) => t < maxHourTotal * 0.05)
    .map(({ h }) => h);

  return {
    tool,
    lookbackDays,
    cells,
    peakHour: peak && peak.tokens > 0 ? { isoDow: peak.isoDow, hour: peak.hour, tokens: peak.tokens } : null,
    quietHours,
  };
}

export function renderHeatmapAscii(hm: Heatmap): string {
  const flat = hm.cells.flat();
  const max = Math.max(1, ...flat.map((c) => c.tokens));
  const shades = ' .:-=+*#%@';
  const lines: string[] = [];
  lines.push('     ' + Array.from({ length: 24 }, (_, h) => String(h % 10)).join(''));
  for (let d = 0; d < 7; d++) {
    const row = hm.cells[d]
      .map((c) => shades[Math.min(shades.length - 1, Math.floor((c.tokens / max) * (shades.length - 1)))])
      .join('');
    lines.push(`${DAY_LABELS[d]}  ${row}`);
  }
  return lines.join('\n');
}

export interface WasteReport {
  tool: ToolName;
  lookbackDays: number;
  windowHoursAvailable: number;
  windowHoursActive: number;
  windowHoursUnused: number;
  deadZoneHoursLost: number;
}

/**
 * Quantifies the headline stat: how much paid-for window capacity went
 * unused, and how much time was lost to the daily dead zone specifically.
 * "Active" hours = hours in which at least one usage event was recorded, as
 * a simple proxy for a window slot actually being exercised.
 */
export function computeWasteReport(tool: ToolName, lookbackDays = 7, now = new Date()): WasteReport {
  const since = new Date(now.getTime() - lookbackDays * 24 * 3600 * 1000);
  const events = usageEventsSince(tool, since.toISOString());

  const activeHourKeys = new Set<string>();
  for (const e of events) {
    const d = new Date(e.occurred_at);
    if (isNaN(d.getTime())) continue;
    activeHourKeys.add(`${d.toDateString()}|${d.getHours()}`);
  }

  const daysWithData = new Set(events.map((e) => new Date(e.occurred_at).toDateString())).size || lookbackDays;
  const windowHoursAvailable = daysWithData * 24; // hours the account existed & could have been used
  const windowHoursActive = activeHourKeys.size;
  const windowHoursUnused = Math.max(0, windowHoursAvailable - windowHoursActive);

  const pattern = latestPattern(tool);
  const deadZoneHoursLost =
    pattern?.deadZoneMinutes != null ? (pattern.deadZoneMinutes / 60) * daysWithData : 0;

  return {
    tool,
    lookbackDays: daysWithData,
    windowHoursAvailable,
    windowHoursActive,
    windowHoursUnused,
    deadZoneHoursLost,
  };
}
