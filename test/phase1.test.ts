import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-p1-'));

import { getDb } from '../src/core/db';
import { getTask, insertRun, insertTask, insertUsageEvents } from '../src/core/repo';
import { addAccount, envForAccount, listAccounts } from '../src/core/accounts';
import { routeAccount } from '../src/core/scheduler/accountRouter';
import { dependencyGate } from '../src/daemon/loop';
import { buildEffectivePrompt, resolveResumeSession } from '../src/daemon/taskRunner';
import { prepareWorkspace, commitWorktreeChanges, diffStat, isLargeCommit, removeWorktree } from '../src/core/git';
import { addProfile, getProfile } from '../src/core/profiles';

test('schema v2: accounts table and new task columns exist', () => {
  const cols = (getDb().prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(
    (c) => c.name
  );
  for (const expected of ['account', 'depends_on', 'same_session', 'instructions', 'resume_session_id', 'branch_mode']) {
    assert.ok(cols.includes(expected), `tasks.${expected} missing`);
  }
  assert.ok(getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'accounts'").get());
});

test('dependencyGate: run/wait/cancel transitions', () => {
  assert.equal(dependencyGate(null), 'run');
  assert.equal(dependencyGate('succeeded'), 'run');
  assert.equal(dependencyGate('queued'), 'wait');
  assert.equal(dependencyGate('running'), 'wait');
  assert.equal(dependencyGate('rate_limited'), 'wait');
  assert.equal(dependencyGate('failed'), 'cancel');
  assert.equal(dependencyGate('cancelled'), 'cancel');
  assert.equal(dependencyGate('expired'), 'cancel');
});

test('buildEffectivePrompt prepends instructions with separator', () => {
  assert.equal(buildEffectivePrompt(null, 'do X'), 'do X');
  assert.equal(buildEffectivePrompt('  ', 'do X'), 'do X');
  assert.equal(buildEffectivePrompt('follow house rules', 'do X'), 'follow house rules\n\n---\n\ndo X');
});

test('resolveResumeSession: explicit continue-from beats chain same-session', () => {
  const depId = insertTask({ prompt: 'dep', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap' });
  const runId = insertRun(depId, 1, 'claude');
  getDb()
    .prepare(`UPDATE task_runs SET outcome = 'success', session_id = 'sess-dep' WHERE id = ?`)
    .run(runId);

  const chained = insertTask({
    prompt: 'child',
    tool: 'claude',
    projectDir: os.tmpdir(),
    scheduleKind: 'asap',
    dependsOn: depId,
    sameSession: true,
  });
  assert.equal(resolveResumeSession(getTask(chained)!), 'sess-dep');

  const explicit = insertTask({
    prompt: 'explicit resume',
    tool: 'claude',
    projectDir: os.tmpdir(),
    scheduleKind: 'asap',
    dependsOn: depId,
    sameSession: true,
    resumeSessionId: 'sess-explicit',
  });
  assert.equal(resolveResumeSession(getTask(explicit)!), 'sess-explicit');
});

test('account router: default login when no account requested or registered', () => {
  const t = insertTask({ prompt: 'x', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap' });
  assert.equal(routeAccount(getTask(t)!).kind, 'default');

  const auto = insertTask({ prompt: 'x', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap', account: 'auto' });
  assert.equal(routeAccount(getTask(auto)!).kind, 'default'); // no accounts registered yet
});

test('account router: auto skips a rate-limited account and env isolation is per-tool', () => {
  addAccount('work', 'claude');
  addAccount('personal', 'claude');
  assert.equal(listAccounts('claude').length, 2);

  // Rate-limit "work" (route_order 0) with a reset 2h in the future.
  insertUsageEvents([
    {
      tool: 'claude',
      source: 'queued_task',
      occurredAt: new Date().toISOString(),
      sessionId: null,
      costUsd: null,
      costUsdEstimated: false,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      rateLimitHit: true,
      rateLimitResetAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
      rawRef: 'session limit',
      account: 'work',
    },
  ]);

  const t = insertTask({ prompt: 'x', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap', account: 'auto' });
  const route = routeAccount(getTask(t)!);
  assert.equal(route.kind, 'account');
  if (route.kind === 'account') {
    assert.equal(route.account.name, 'personal');
    assert.ok(envForAccount(route.account).CLAUDE_CONFIG_DIR.includes('claude-personal'));
  }

  // Pinned to the blocked account -> unavailable (temporary, keep retrying).
  const pinned = insertTask({ prompt: 'x', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap', account: 'work' });
  assert.equal(routeAccount(getTask(pinned)!).kind, 'unavailable');
});

test('account router: nonexistent/wrong-tool account is misconfigured (permanent), not unavailable (temporary)', () => {
  const badName = insertTask({ prompt: 'x', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap', account: 'does-not-exist' });
  assert.equal(routeAccount(getTask(badName)!).kind, 'misconfigured');

  addAccount('codex-work', 'codex');
  const wrongTool = insertTask({ prompt: 'x', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap', account: 'codex-work' });
  assert.equal(routeAccount(getTask(wrongTool)!).kind, 'misconfigured');
});

test('prepareWorkspace: git repo gets an isolated worktree branch; non-repo runs in place', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-repo-'));
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@test.dev'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });

  const noop = () => {};
  const ws = prepareWorkspace('abcdef1234567890', repo, 'auto', noop);
  assert.equal(ws.gitBranch, 'spareloop/abcdef12');
  assert.ok(ws.worktreePath && fs.existsSync(path.join(ws.worktreePath, 'a.txt')));
  assert.notEqual(ws.runDir, repo);

  // Retry reuses the same worktree instead of failing on the existing branch.
  const ws2 = prepareWorkspace('abcdef1234567890', repo, 'auto', noop);
  assert.equal(ws2.runDir, ws.runDir);

  // branch_mode none -> run in place.
  const inPlace = prepareWorkspace('fedcba0987654321', repo, 'none', noop);
  assert.equal(inPlace.runDir, repo);
  assert.equal(inPlace.gitBranch, null);

  // Non-git dir -> run in place.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-plain-'));
  assert.equal(prepareWorkspace('1234567890abcdef', plain, 'auto', noop).runDir, plain);
});

test('commitWorktreeChanges: agent edits land as a real commit, not just uncommitted files', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-commit-repo-'));
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@test.dev'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });

  const noop = () => {};
  const ws = prepareWorkspace('1111222233334444', repo, 'auto', noop);
  // Simulate what an agent does: create/edit files in the worktree.
  fs.writeFileSync(path.join(ws.worktreePath!, 'notes.txt'), 'hello from the agent');

  const result = commitWorktreeChanges(ws.worktreePath!, 'spareloop: attempt 1 (success) - test task');
  assert.equal(result.committed, true);
  assert.equal(result.fileCount, 1);

  // The whole point: a diff against the branch now shows real, committed
  // changes - not nothing, which is what a bare uncommitted worktree gives.
  const stat = diffStat(repo, ws.gitBranch!);
  assert.ok(stat);
  assert.match(stat!, /notes\.txt/);

  // No-op on a clean worktree (nothing to commit).
  const noop2 = commitWorktreeChanges(ws.worktreePath!, 'should not commit anything');
  assert.equal(noop2.committed, false);
  assert.equal(noop2.fileCount, 0);
});

test('isLargeCommit: flags unusually large file counts (e.g. an accidentally-swept build artifact)', () => {
  assert.equal(isLargeCommit(5), false);
  assert.equal(isLargeCommit(200), false);
  assert.equal(isLargeCommit(201), true);
  assert.equal(isLargeCommit(5000), true);
});

test('removeWorktree: real removal via git, branch stays checkable out afterward', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-rmwt-repo-'));
  execFileSync('git', ['-C', repo, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@test.dev'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'v1');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });

  const noop = () => {};
  const ws = prepareWorkspace('9999888877776666', repo, 'auto', noop);
  fs.writeFileSync(path.join(ws.worktreePath!, 'notes.txt'), 'hi');
  commitWorktreeChanges(ws.worktreePath!, 'snapshot');

  assert.ok(fs.existsSync(ws.worktreePath!));
  const ok = removeWorktree(ws.worktreePath!, repo);
  assert.equal(ok, true);
  assert.ok(!fs.existsSync(ws.worktreePath!));

  // Branch survives worktree removal - the whole point of not deleting it.
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', ws.gitBranch!], { encoding: 'utf8' });
  assert.match(branches, new RegExp(ws.gitBranch!.split('/')[1]));
});

test('profiles: round-trip with account and instructions', () => {
  addProfile({
    name: 'backend',
    tool: 'claude',
    projectDir: os.tmpdir(),
    model: 'sonnet',
    account: 'auto',
    instructions: 'Always run the tests.',
  });
  const p = getProfile('backend')!;
  assert.equal(p.tool, 'claude');
  assert.equal(p.account, 'auto');
  assert.equal(p.instructions, 'Always run the tests.');
});
