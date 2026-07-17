import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-adapters-'));

import { CodexAdapter } from '../src/adapters/codex';
import { CursorAdapter } from '../src/adapters/cursor';

/**
 * These lock in flag shapes verified against real installs (codex-cli
 * 0.144.5, cursor-agent) on 2026-07-17 - see comments in the adapter source
 * for what was actually tested. If a future CLI release changes these
 * flags, these tests should fail loudly rather than silently drifting.
 */

test('CodexAdapter: exec mode never passes -a/--ask-for-approval (rejected by real CLI)', () => {
  const a = new CodexAdapter();
  const args = a.buildArgs({ prompt: 'x', projectDir: '/tmp', permissionMode: 'allowlist' });
  assert.ok(!args.includes('-a'));
  assert.ok(!args.includes('--ask-for-approval'));
  assert.ok(args.includes('-s'));
  assert.ok(args.includes('workspace-write'));
});

test('CodexAdapter: resume mode omits -s/--sandbox (rejected by exec resume)', () => {
  const a = new CodexAdapter();
  const args = a.buildArgs({
    prompt: 'continue',
    projectDir: '/tmp',
    permissionMode: 'allowlist',
    resumeSessionId: 'abc-123',
  });
  assert.deepEqual(args, ['exec', 'resume', 'abc-123', 'continue', '--json', '--skip-git-repo-check']);
});

test('CodexAdapter: full_bypass works both fresh and resumed', () => {
  const a = new CodexAdapter();
  const fresh = a.buildArgs({ prompt: 'x', projectDir: '/tmp', permissionMode: 'full_bypass' });
  assert.ok(fresh.includes('--dangerously-bypass-approvals-and-sandbox'));
  const resumed = a.buildArgs({
    prompt: 'x',
    projectDir: '/tmp',
    permissionMode: 'full_bypass',
    resumeSessionId: 'abc-123',
  });
  assert.ok(resumed.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!resumed.includes('-s'));
});

test('CodexAdapter: always passes --skip-git-repo-check (verified real Codex refuses non-git dirs otherwise)', () => {
  const a = new CodexAdapter();
  assert.ok(a.buildArgs({ prompt: 'x', projectDir: '/tmp', permissionMode: 'allowlist' }).includes('--skip-git-repo-check'));
  assert.ok(
    a
      .buildArgs({ prompt: 'x', projectDir: '/tmp', permissionMode: 'allowlist', resumeSessionId: 'abc' })
      .includes('--skip-git-repo-check')
  );
});

test('CodexAdapter: capability flag reflects verified resume support', () => {
  const a = new CodexAdapter();
  assert.equal(a.capabilities.supportsSessionResume, true);
});

test('CursorAdapter: buildArgs shape matches verified real CLI flags', () => {
  const a = new CursorAdapter();
  const args = a.buildArgs({ prompt: 'x', projectDir: '/tmp', permissionMode: 'allowlist' });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('json'));
  assert.ok(args.includes('--trust'));
  assert.ok(!args.includes('--force'));

  const bypass = a.buildArgs({ prompt: 'x', projectDir: '/tmp', permissionMode: 'full_bypass' });
  assert.ok(bypass.includes('--force'));
});

test('CursorAdapter: --resume <chatId> accepted (verified against real CLI parsing)', () => {
  const a = new CursorAdapter();
  const args = a.buildArgs({
    prompt: 'continue',
    projectDir: '/tmp',
    permissionMode: 'allowlist',
    resumeSessionId: 'chat-abc-123',
  });
  const idx = args.indexOf('--resume');
  assert.ok(idx !== -1);
  assert.equal(args[idx + 1], 'chat-abc-123');
  assert.equal(a.capabilities.supportsSessionResume, true);
});
