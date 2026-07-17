import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-orphan-'));

import { getDb } from '../src/core/db';
import { getTask, insertRun, insertTask, updateTaskStatus } from '../src/core/repo';
import { tick } from '../src/daemon/loop';

test('orphaned running task with stale never-ended run is re-queued', async () => {
  const taskId = insertTask({
    prompt: 'orphan me',
    tool: 'claude',
    projectDir: os.tmpdir(),
    scheduleKind: 'explicit',
    scheduleAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(), // far future: won't relaunch this tick
  });
  const runId = insertRun(taskId, 1, 'claude');
  updateTaskStatus(taskId, 'running');
  // Backdate the run start past the 90-minute orphan threshold.
  getDb()
    .prepare(`UPDATE task_runs SET started_at = datetime('now', '-3 hours') WHERE id = ?`)
    .run(runId);
  getDb().prepare(`UPDATE tasks SET attempt_count = 1 WHERE id = ?`).run(taskId);

  await tick(new Date());

  const task = getTask(taskId)!;
  assert.equal(task.status, 'queued');
  const run = getDb().prepare('SELECT * FROM task_runs WHERE id = ?').get(runId) as any;
  assert.equal(run.outcome, 'failure');
  assert.match(run.error_message, /orphaned/);
});

test('orphaned running task whose run ended is transitioned off running', async () => {
  const taskId = insertTask({
    prompt: 'crash between finishRun and status update',
    tool: 'codex',
    projectDir: os.tmpdir(),
    scheduleKind: 'explicit',
    scheduleAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    maxAttempts: 1,
  });
  const runId = insertRun(taskId, 1, 'codex');
  updateTaskStatus(taskId, 'running');
  getDb()
    .prepare(`UPDATE task_runs SET ended_at = datetime('now'), outcome = 'failure' WHERE id = ?`)
    .run(runId);
  getDb().prepare(`UPDATE tasks SET attempt_count = 1 WHERE id = ?`).run(taskId);

  await tick(new Date());

  const task = getTask(taskId)!;
  assert.equal(task.status, 'failed'); // attempts exhausted
});

test('recently-started running task is NOT reaped', async () => {
  const taskId = insertTask({
    prompt: 'legitimately running',
    tool: 'cursor',
    projectDir: os.tmpdir(),
    scheduleKind: 'explicit',
    scheduleAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  });
  insertRun(taskId, 1, 'cursor');
  updateTaskStatus(taskId, 'running');

  await tick(new Date());

  assert.equal(getTask(taskId)!.status, 'running');
});
