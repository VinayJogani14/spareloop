import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Point spareloop at a throwaway data dir BEFORE importing anything that touches the DB.
process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-test-'));

import { computePrewarm } from '../src/core/patterns/prewarmComputer';
import {
  detectDailyWindow,
  fromHHMM,
  toHHMM,
  weightedMedian,
  WindowPattern,
} from '../src/core/patterns/windowDetector';
import { parseResetPhrase, looksRateLimited } from '../src/adapters/resetParser';
import { insertUsageEvents } from '../src/core/repo';
import { NewUsageEvent } from '../src/adapters/types';

test('prewarm formula matches the canonical example: exhaust 12:10 -> prewarm 07:05', () => {
  const pattern: WindowPattern = {
    id: 'p1',
    tool: 'claude',
    windowStartLocal: '09:00',
    windowExhaustionLocal: '12:10',
    windowResetLocal: '14:00',
    deadZoneMinutes: 110,
    confidence: 1,
    sampleDays: 10,
    observations: [],
  };
  const d = computePrewarm(pattern);
  assert.equal(d.worthEnabling, true);
  assert.equal(d.proposedLocalTime, '07:05'); // 12:10 - 5h - 5min margin
});

test('prewarm declines when dead zone is trivial', () => {
  const pattern: WindowPattern = {
    id: 'p2',
    tool: 'claude',
    windowStartLocal: '09:00',
    windowExhaustionLocal: '13:50',
    windowResetLocal: '14:00',
    deadZoneMinutes: 10,
    confidence: 1,
    sampleDays: 10,
    observations: [],
  };
  assert.equal(computePrewarm(pattern).worthEnabling, false);
});

test('prewarm declines with no exhaustion data', () => {
  const pattern: WindowPattern = {
    id: 'p3',
    tool: 'codex',
    windowStartLocal: '09:00',
    windowExhaustionLocal: null,
    windowResetLocal: null,
    deadZoneMinutes: null,
    confidence: 0,
    sampleDays: 0,
    observations: [],
  };
  assert.equal(computePrewarm(pattern).worthEnabling, false);
});

test('weightedMedian resists outliers and respects weights', () => {
  assert.equal(weightedMedian([[100, 1], [110, 1], [500, 0.01]]), 110);
  assert.equal(weightedMedian([]), null);
});

test('HH:MM round-trips including negative wrap', () => {
  assert.equal(toHHMM(fromHHMM('07:05')), '07:05');
  assert.equal(toHHMM(-55), '23:05'); // 12:10am exhaustion minus 5h5m wraps to prior evening
});

test('reset phrase parser handles Claude-style messages', () => {
  const now = new Date('2026-07-17T10:00:00');
  const r1 = parseResetPhrase("You've hit your session limit · resets 3:45pm", now);
  assert.ok(r1);
  assert.equal(r1!.getHours(), 15);
  assert.equal(r1!.getMinutes(), 45);

  const r2 = parseResetPhrase("You've hit your weekly limit · resets Mon 12:00am", now);
  assert.ok(r2);
  assert.equal(r2!.getDay(), 1);
  assert.equal(r2!.getHours(), 0);

  assert.equal(parseResetPhrase('no reset info here', now), null);
});

test('rate limit detection patterns', () => {
  assert.ok(looksRateLimited("You've hit your session limit · resets 3:45pm"));
  assert.ok(looksRateLimited('Claude usage limit reached'));
  assert.ok(!looksRateLimited('task completed successfully'));
});

test('detectDailyWindow reconstructs pattern from synthetic history', () => {
  const events: NewUsageEvent[] = [];
  const now = new Date();
  // 6 days of: first event ~9:00, rate-limit hit ~12:10 with reset 14:00
  for (let dayAgo = 1; dayAgo <= 6; dayAgo++) {
    const day = new Date(now.getTime() - dayAgo * 24 * 3600 * 1000);
    const at = (h: number, m: number) => {
      const d = new Date(day);
      d.setHours(h, m, 0, 0);
      return d;
    };
    events.push(mkEvent('claude', at(9, 0), false, null));
    events.push(mkEvent('claude', at(10, 30), false, null));
    const reset = at(14, 0);
    events.push(mkEvent('claude', at(12, 10), true, reset.toISOString()));
  }
  insertUsageEvents(events);

  const pattern = detectDailyWindow('claude', now);
  assert.equal(pattern.windowStartLocal, '09:00');
  assert.equal(pattern.windowExhaustionLocal, '12:10');
  assert.equal(pattern.windowResetLocal, '14:00');
  assert.equal(pattern.deadZoneMinutes, 110);
  assert.ok(pattern.confidence >= 0.9);

  const decision = computePrewarm(pattern);
  assert.equal(decision.worthEnabling, true);
  assert.equal(decision.proposedLocalTime, '07:05');
});

function mkEvent(
  tool: 'claude' | 'codex' | 'cursor',
  at: Date,
  rateLimitHit: boolean,
  resetIso: string | null
): NewUsageEvent {
  return {
    tool,
    source: 'interactive',
    occurredAt: at.toISOString(),
    sessionId: null,
    costUsd: 0.5,
    costUsdEstimated: false,
    inputTokens: 1000,
    outputTokens: 500,
    cachedInputTokens: 0,
    rateLimitHit,
    rateLimitResetAt: resetIso,
    rawRef: null,
  };
}
