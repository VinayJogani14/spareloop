import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-peracct-'));

import { insertUsageEvents } from '../src/core/repo';
import { detectDailyWindow, latestPattern } from '../src/core/patterns/windowDetector';
import { computePrewarm, getPrewarmConfig, setPrewarmConfig, listPrewarmConfigs } from '../src/core/patterns/prewarmComputer';
import { NewUsageEvent } from '../src/adapters/types';

function seedDay(account: string | null, dayAgo: number, startH: number, hitH: number, hitM: number, resetH: number) {
  const now = new Date();
  const day = new Date(now.getTime() - dayAgo * 24 * 3600 * 1000);
  const at = (h: number, m: number) => {
    const d = new Date(day);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const events: NewUsageEvent[] = [
    {
      tool: 'claude',
      source: 'interactive',
      occurredAt: at(startH, 0).toISOString(),
      sessionId: null,
      costUsd: null,
      costUsdEstimated: false,
      inputTokens: 500,
      outputTokens: 200,
      cachedInputTokens: 0,
      rateLimitHit: false,
      rateLimitResetAt: null,
      rawRef: null,
      account,
    },
    {
      tool: 'claude',
      source: 'interactive',
      occurredAt: at(hitH, hitM).toISOString(),
      sessionId: null,
      costUsd: null,
      costUsdEstimated: false,
      inputTokens: 500,
      outputTokens: 200,
      cachedInputTokens: 0,
      rateLimitHit: true,
      rateLimitResetAt: at(resetH, 0).toISOString(),
      rawRef: null,
      account,
    },
  ];
  insertUsageEvents(events);
}

test('per-account prewarm: two accounts with different rhythms get independent patterns and prewarm times', () => {
  // Default login: 09:00 start, exhausts 12:00, resets 14:00 -> prewarm ~06:55
  // "work" account: 06:00 start, exhausts 08:30, resets 11:00 -> prewarm ~03:25
  for (let d = 1; d <= 6; d++) {
    seedDay(null, d, 9, 12, 0, 14);
    seedDay('work', d, 6, 8, 30, 11);
  }

  const defaultPattern = detectDailyWindow('claude', new Date(), null);
  const workPattern = detectDailyWindow('claude', new Date(), 'work');

  assert.equal(defaultPattern.windowExhaustionLocal, '12:00');
  assert.equal(workPattern.windowExhaustionLocal, '08:30');
  assert.notEqual(defaultPattern.windowExhaustionLocal, workPattern.windowExhaustionLocal);

  const defaultDecision = computePrewarm(defaultPattern);
  const workDecision = computePrewarm(workPattern);
  assert.equal(defaultDecision.proposedLocalTime, '06:55');
  assert.equal(workDecision.proposedLocalTime, '03:25');

  // latestPattern retrieval is also account-scoped and doesn't cross-contaminate.
  assert.equal(latestPattern('claude', null)!.windowExhaustionLocal, '12:00');
  assert.equal(latestPattern('claude', 'work')!.windowExhaustionLocal, '08:30');
});

test('per-account prewarm config: enabling one account does not affect another or the default login', () => {
  setPrewarmConfig('claude', null, { enabled: true, scheduledLocalTime: '06:55' });
  setPrewarmConfig('claude', 'work', { enabled: true, scheduledLocalTime: '03:25' });
  setPrewarmConfig('claude', 'personal', { enabled: false });

  assert.equal(getPrewarmConfig('claude', null)!.scheduled_local_time, '06:55');
  assert.equal(getPrewarmConfig('claude', 'work')!.scheduled_local_time, '03:25');
  assert.equal(getPrewarmConfig('claude', 'personal')!.enabled, 0);

  const all = listPrewarmConfigs('claude');
  assert.equal(all.length, 3);
  assert.ok(all.some((c) => c.account === '' && c.scheduled_local_time === '06:55'));
  assert.ok(all.some((c) => c.account === 'work' && c.scheduled_local_time === '03:25'));
});
