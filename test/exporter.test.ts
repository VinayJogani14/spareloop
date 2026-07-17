import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-export-'));

import { toCsv, exportUsageEvents, exportTaskRuns } from '../src/core/exporter';
import { insertUsageEvents, insertTask, insertRun, finishRun } from '../src/core/repo';

test('toCsv: escapes commas, quotes, and newlines correctly', () => {
  const csv = toCsv([
    { a: 'plain', b: 'has,comma', c: 'has"quote', d: 'has\nnewline' },
  ]);
  // A quoted field may legitimately contain a literal newline (valid CSV) -
  // check the raw output directly rather than naively splitting on '\n'.
  assert.equal(csv, 'a,b,c,d\nplain,"has,comma","has""quote","has\nnewline"\n');
});

test('toCsv: empty input produces empty string', () => {
  assert.equal(toCsv([]), '');
});

test('exportUsageEvents: real round trip, respects tool filter and lookback window', () => {
  const now = new Date();
  const recent = new Date(now.getTime() - 1000).toISOString();
  const old = new Date(now.getTime() - 40 * 24 * 3600 * 1000).toISOString();
  insertUsageEvents([
    { tool: 'claude', source: 'interactive', occurredAt: recent, sessionId: null, costUsd: 1.5, costUsdEstimated: false, inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, rateLimitHit: false, rateLimitResetAt: null, rawRef: null, account: null },
    { tool: 'codex', source: 'interactive', occurredAt: recent, sessionId: null, costUsd: null, costUsdEstimated: false, inputTokens: 200, outputTokens: 80, cachedInputTokens: 0, rateLimitHit: false, rateLimitResetAt: null, rawRef: null, account: null },
    { tool: 'claude', source: 'interactive', occurredAt: old, sessionId: null, costUsd: 9, costUsdEstimated: false, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, rateLimitHit: false, rateLimitResetAt: null, rawRef: null, account: null },
  ]);

  const all = exportUsageEvents({ days: 30 });
  assert.equal(all.length, 2); // old one excluded by 30-day window

  const claudeOnly = exportUsageEvents({ tool: 'claude', days: 30 });
  assert.equal(claudeOnly.length, 1);
  assert.equal(claudeOnly[0].cost_usd, 1.5);

  const csv = toCsv(all);
  assert.match(csv, /tool,account,source,occurred_at/);
});

test('exportTaskRuns: joins task info and respects filters', () => {
  const taskId = insertTask({ prompt: 'export me', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap' });
  const runId = insertRun(taskId, 1, 'claude');
  finishRun(runId, { outcome: 'success', exitCode: 0, metrics: { costUsd: 0.25, costUsdEstimated: false, durationMs: 500 } });

  const rows = exportTaskRuns({ days: 30 });
  assert.ok(rows.some((r) => r.prompt === 'export me' && r.cost_usd === 0.25));
});
