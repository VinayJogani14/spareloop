import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

/**
 * Every other test file calls internal functions directly. None of them
 * would catch a real wiring regression in cli/index.ts itself - a renamed
 * flag, a broken option parser, a command that throws on startup. These
 * tests spawn the actual compiled binary as a real subprocess, the same way
 * a user's shell would, and check its real stdout/exit code.
 */

const CLI_PATH = path.join(__dirname, '../src/cli/index.js');

function run(args: string[], env: Record<string, string> = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout ?? '') + (err.stderr ?? ''), status: err.status ?? 1 };
  }
}

function freshHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-e2e-'));
}

test('cli: --version reports the package version', () => {
  const { stdout, status } = run(['--version'], { SPARELOOP_HOME: freshHome() });
  assert.equal(status, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('cli: full task lifecycle through the real binary - add, list, show, cancel', () => {
  const home = freshHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-e2e-proj-'));

  const add = run(
    ['add', '--tool', 'claude', '--dir', dir, '--prompt', 'end to end test task', '--asap'],
    { SPARELOOP_HOME: home }
  );
  assert.equal(add.status, 0);
  const idMatch = add.stdout.match(/Queued task ([a-f0-9]{8})/);
  assert.ok(idMatch, `expected a queued-task id in: ${add.stdout}`);
  const id = idMatch![1];

  const list = run(['list'], { SPARELOOP_HOME: home });
  assert.equal(list.status, 0);
  assert.match(list.stdout, new RegExp(id));
  assert.match(list.stdout, /queued/);

  const show = run(['show', id], { SPARELOOP_HOME: home });
  assert.equal(show.status, 0);
  assert.match(show.stdout, /end to end test task/);

  const cancel = run(['cancel', id], { SPARELOOP_HOME: home });
  assert.equal(cancel.status, 0);
  assert.match(cancel.stdout, /Cancelled/);

  const listAfter = run(['list', '--status', 'queued'], { SPARELOOP_HOME: home });
  assert.ok(!listAfter.stdout.includes(id));
});

test('cli: doctor runs clean on a fresh environment and exits 0', () => {
  const { stdout, status } = run(['doctor'], { SPARELOOP_HOME: freshHome() });
  assert.equal(status, 0);
  assert.match(stdout, /data dir writable/);
  assert.match(stdout, /0 error/);
});

test('cli: export --format json produces valid, parseable JSON', () => {
  const { stdout, status } = run(['export', '--what', 'usage', '--format', 'json'], {
    SPARELOOP_HOME: freshHome(),
  });
  assert.equal(status, 0);
  assert.doesNotThrow(() => JSON.parse(stdout));
});

test('cli: memory list shows both registered providers with their required env vars', () => {
  const { stdout, status } = run(['memory', 'list'], { SPARELOOP_HOME: freshHome() });
  assert.equal(status, 0);
  assert.match(stdout, /mem0/);
  assert.match(stdout, /supermemory/);
  assert.match(stdout, /MEM0_API_KEY/);
});

test('cli: clean reports nothing to do on a fresh environment', () => {
  const { stdout, status } = run(['clean'], { SPARELOOP_HOME: freshHome() });
  assert.equal(status, 0);
  assert.match(stdout, /Nothing to clean/);
});

test('cli: rejects an unknown tool with a clear error and non-zero exit', () => {
  const { stdout, status } = run(
    ['add', '--tool', 'not-a-real-tool', '--dir', os.tmpdir(), '--prompt', 'x', '--asap'],
    { SPARELOOP_HOME: freshHome() }
  );
  assert.notEqual(status, 0);
  assert.match(stdout, /unknown tool/);
});
