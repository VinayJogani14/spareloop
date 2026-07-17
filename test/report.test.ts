import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-report-'));

import { getDb } from '../src/core/db';
import { finishRun, insertRun, insertTask, runsSince, cleanableWorktrees } from '../src/core/repo';
import { diffStat } from '../src/core/git';

function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-report-repo-'));
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.dev'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'T'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });
  return repo;
}

test('runsSince returns recent runs joined with task info, oldest excluded', () => {
  const taskId = insertTask({ prompt: 'do a thing', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap' });
  const runId = insertRun(taskId, 1, 'claude');
  finishRun(runId, { outcome: 'success', exitCode: 0, metrics: { costUsd: 0.5, costUsdEstimated: false, durationMs: 1000 } });

  const oldTaskId = insertTask({ prompt: 'ancient task', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap' });
  const oldRunId = insertRun(oldTaskId, 1, 'claude');
  getDb().prepare(`UPDATE task_runs SET started_at = datetime('now', '-3 days') WHERE id = ?`).run(oldRunId);
  finishRun(oldRunId, { outcome: 'success', exitCode: 0 });

  const runs = runsSince(12);
  assert.ok(runs.some((r) => r.task_id === taskId));
  assert.ok(!runs.some((r) => r.task_id === oldTaskId));
  const recent = runs.find((r) => r.task_id === taskId)!;
  assert.equal(recent.prompt, 'do a thing');
  assert.equal(recent.cost_usd, 0.5);
});

test('diffStat reflects real file changes on a branch, null when no diff exists', () => {
  const repo = initRepo();
  const baseBranch = execFileSync('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', repo, 'checkout', '-b', 'spareloop/test1'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v2 - changed by the task\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new file\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'task changes'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'checkout', baseBranch], { stdio: 'ignore' });

  const stat = diffStat(repo, 'spareloop/test1');
  assert.ok(stat);
  assert.match(stat!, /a\.txt/);
  assert.match(stat!, /b\.txt/);
  assert.match(stat!, /2 files changed/);

  execFileSync('git', ['-C', repo, 'checkout', '-b', 'spareloop/empty'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'checkout', baseBranch], { stdio: 'ignore' });
  assert.equal(diffStat(repo, 'spareloop/empty'), null);

  assert.equal(diffStat(repo, 'branch-does-not-exist'), null);
});

test('cleanableWorktrees: only terminal-status tasks past the age threshold, never queued/running', () => {
  const mkRun = (status: 'succeeded' | 'failed' | 'queued' | 'running', daysAgo: number, wt = '/tmp/wt-x') => {
    const taskId = insertTask({ prompt: 'x', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap' });
    const runId = insertRun(taskId, 1, 'claude');
    getDb()
      .prepare(`UPDATE task_runs SET ended_at = datetime('now', ?), worktree_path = ?, git_branch = ? WHERE id = ?`)
      .run(`-${daysAgo} days`, wt, 'spareloop/x', runId);
    if (status === 'succeeded' || status === 'failed') {
      getDb().prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, taskId);
    } else {
      getDb().prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, taskId);
    }
    return taskId;
  };

  const oldSucceeded = mkRun('succeeded', 10, '/tmp/wt-old-success');
  mkRun('succeeded', 1, '/tmp/wt-recent-success'); // too recent
  mkRun('running', 10, '/tmp/wt-still-running'); // non-terminal, never cleaned regardless of age
  const oldFailed = mkRun('failed', 5, '/tmp/wt-old-fail');

  const cleanable = cleanableWorktrees(3);
  const paths = cleanable.map((c) => c.worktree_path);
  assert.ok(paths.includes('/tmp/wt-old-success'));
  assert.ok(paths.includes('/tmp/wt-old-fail'));
  assert.ok(!paths.includes('/tmp/wt-recent-success'));
  assert.ok(!paths.includes('/tmp/wt-still-running'));
  assert.ok(cleanable.some((c) => c.task_id === oldSucceeded));
  assert.ok(cleanable.some((c) => c.task_id === oldFailed));
});
