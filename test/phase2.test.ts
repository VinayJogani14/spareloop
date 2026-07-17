import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-p2-'));

import { insertUsageEvents } from '../src/core/repo';
import { computeExhaustionBudget, currentWindowSnapshot, predictWeekly, predictWindow } from '../src/core/patterns/predictor';
import { computeHeatmap, computeWasteReport } from '../src/core/patterns/heatmap';
import { renderOneLine } from '../src/core/statusLine';
import { NewUsageEvent } from '../src/adapters/types';

function evt(overrides: Partial<NewUsageEvent> & { occurredAt: string }): NewUsageEvent {
  return {
    tool: 'claude',
    source: 'interactive',
    sessionId: null,
    costUsd: null,
    costUsdEstimated: false,
    inputTokens: 1000,
    outputTokens: 500,
    cachedInputTokens: 0,
    rateLimitHit: false,
    rateLimitResetAt: null,
    rawRef: null,
    account: null,
    ...overrides,
  };
}

test('predictWindow: no data before any usage today', () => {
  const p = predictWindow('codex', new Date());
  assert.equal(p.hasData, false);
});

test('predictWindow: ETA shrinks as cumulative usage approaches historical exhaustion budget', () => {
  const now = new Date();
  now.setHours(11, 0, 0, 0);

  // 5 historical days: window starts 09:00, exhausts at 12:00 with ~9000 tokens burned by then.
  for (let d = 1; d <= 5; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() - d);
    const mk = (h: number, m: number, tokens: number, rl = false) => {
      const at = new Date(day);
      at.setHours(h, m, 0, 0);
      return evt({ occurredAt: at.toISOString(), inputTokens: tokens, outputTokens: 0, rateLimitHit: rl });
    };
    insertUsageEvents([
      mk(9, 0, 2000),
      mk(10, 0, 3000),
      mk(11, 30, 3000),
      { ...mk(12, 0, 1000, true), rateLimitResetAt: new Date(day.setHours(14, 0, 0, 0)).toISOString() },
    ]);
  }

  const budget = computeExhaustionBudget('claude', now);
  assert.ok(budget.medianTokens != null && budget.medianTokens > 8000 && budget.medianTokens < 10000);
  assert.equal(budget.sampleDays, 5);

  // Today: window started 09:00, we're at 11:00 with 6000 tokens burned so far.
  const today9 = new Date(now);
  today9.setHours(9, 0, 0, 0);
  const today1030 = new Date(now);
  today1030.setHours(10, 30, 0, 0);
  insertUsageEvents([
    evt({ occurredAt: today9.toISOString(), inputTokens: 3000, outputTokens: 0 }),
    evt({ occurredAt: today1030.toISOString(), inputTokens: 3000, outputTokens: 0 }),
  ]);

  const snapshot = currentWindowSnapshot('claude', now)!;
  assert.ok(snapshot.cumulativeTokens >= 6000);

  const prediction = predictWindow('claude', now);
  assert.equal(prediction.hasData, true);
  assert.ok(prediction.etaMinutes != null && prediction.etaMinutes > 0);
  assert.ok(prediction.percentOfTypicalBudget! > 60 && prediction.percentOfTypicalBudget! < 80);
});

test('predictWindow: reports imminent wall once over the typical budget', () => {
  const now = new Date();
  now.setHours(11, 0, 0, 0);
  for (let d = 1; d <= 5; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() - d);
    const at = (h: number) => {
      const x = new Date(day);
      x.setHours(h, 0, 0, 0);
      return x.toISOString();
    };
    insertUsageEvents([
      evt({ occurredAt: at(9), inputTokens: 1000, outputTokens: 0 }),
      { ...evt({ occurredAt: at(10), inputTokens: 500, outputTokens: 0, rateLimitHit: true }), rateLimitResetAt: at(15) },
    ]);
  }
  const today9 = new Date(now);
  today9.setHours(9, 0, 0, 0);
  insertUsageEvents([evt({ tool: 'codex', occurredAt: today9.toISOString(), inputTokens: 5000, outputTokens: 0 })]);
  // budget is for 'claude' above; use codex separately to isolate this test's own history
  for (let d = 1; d <= 5; d++) {
    const day = new Date(now);
    day.setDate(day.getDate() - d);
    const at = (h: number) => {
      const x = new Date(day);
      x.setHours(h, 0, 0, 0);
      return x.toISOString();
    };
    insertUsageEvents([
      evt({ tool: 'codex', occurredAt: at(9), inputTokens: 1000, outputTokens: 0 }),
      { ...evt({ tool: 'codex', occurredAt: at(10), inputTokens: 500, outputTokens: 0, rateLimitHit: true }), rateLimitResetAt: at(15) },
    ]);
  }

  const prediction = predictWindow('codex', now);
  assert.equal(prediction.etaMinutes, 0);
  assert.match(prediction.reason, /any moment/);
});

test('heatmap: identifies the peak hour and flags quiet hours', () => {
  const now = new Date();
  const day = new Date(now);
  day.setDate(day.getDate() - 1);
  const at = (h: number) => {
    const x = new Date(day);
    x.setHours(h, 0, 0, 0);
    return x.toISOString();
  };
  insertUsageEvents([
    evt({ tool: 'cursor', occurredAt: at(14), inputTokens: 5000, outputTokens: 0 }),
    evt({ tool: 'cursor', occurredAt: at(14), inputTokens: 5000, outputTokens: 0 }),
    evt({ tool: 'cursor', occurredAt: at(9), inputTokens: 100, outputTokens: 0 }),
  ]);
  const hm = computeHeatmap('cursor', 21, now);
  assert.ok(hm.peakHour);
  assert.equal(hm.peakHour!.hour, 14);
  assert.ok(hm.quietHours.length > 0);
});

test('waste report: unused hours never exceed available hours', () => {
  const now = new Date();
  insertUsageEvents([evt({ tool: 'cursor', occurredAt: now.toISOString(), inputTokens: 100, outputTokens: 0 })]);
  const waste = computeWasteReport('cursor', 7, now);
  assert.ok(waste.windowHoursUnused <= waste.windowHoursAvailable);
  assert.ok(waste.windowHoursActive >= 1);
});

test('weekly forecast: projects from fraction of week elapsed', () => {
  const now = new Date();
  insertUsageEvents([evt({ tool: 'cursor', occurredAt: now.toISOString(), inputTokens: 1000, outputTokens: 0, costUsd: 1 })]);
  const w = predictWeekly('cursor', now);
  assert.equal(w.hasData, true);
  assert.ok(w.projectedWeekCostUsd! >= (w.costUsdSoFar ?? 0));
});

test('status line renders without throwing when there is no data', () => {
  const line = renderOneLine('codex' as any, new Date('2099-01-01'));
  assert.match(line, /spareloop\[codex\]/);
});
