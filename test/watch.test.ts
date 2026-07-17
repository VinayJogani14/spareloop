import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-watch-'));

import { renderDashboard } from '../src/core/watch';
import { insertTask, updateTaskStatus } from '../src/core/repo';

test('renderDashboard: renders cleanly with no data (cold start)', () => {
  const out = renderDashboard();
  assert.match(out, /spareloop watch/);
  assert.match(out, /daemon: NOT RUNNING/);
  assert.match(out, /Claude Code/);
  assert.match(out, /Codex CLI/);
  assert.match(out, /Cursor/);
  assert.match(out, /0 queued · 0 running · 0 rate-limited/);
});

test('renderDashboard: shows running tasks with tool/account/prompt', () => {
  const taskId = insertTask({
    prompt: 'a running background task with a fairly long description',
    tool: 'claude',
    projectDir: os.tmpdir(),
    scheduleKind: 'asap',
    account: 'work',
  });
  updateTaskStatus(taskId, 'running');

  const out = renderDashboard();
  assert.match(out, /0 queued · 1 running · 0 rate-limited/);
  assert.match(out, new RegExp(taskId.slice(0, 8)));
  assert.match(out, /claude@work/);
});

test('renderDashboard: never throws even with a corrupt/missing daemon log', () => {
  assert.doesNotThrow(() => renderDashboard());
});
