import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-doctor-'));

import { runDoctor } from '../src/core/doctor';
import { insertTask } from '../src/core/repo';
import { addAccount } from '../src/core/accounts';
import { addProfile } from '../src/core/profiles';

test('doctor: flags a task pinned to a nonexistent account as an error (the silent-forever-retry bug class)', async () => {
  insertTask({ prompt: 'stuck forever', tool: 'claude', projectDir: os.tmpdir(), scheduleKind: 'asap', account: 'ghost-account' });
  const { checks } = await runDoctor();
  assert.ok(checks.some((c) => c.status === 'error' && /misconfigured and will never run/.test(c.message)));
});

test('doctor: reports missing memory-provider env as an error', async () => {
  delete process.env.MEM0_API_KEY;
  addProfile({ name: 'doctor-memtest', tool: 'claude', projectDir: os.tmpdir(), memoryProvider: 'mem0' });
  const { checks } = await runDoctor();
  assert.ok(checks.some((c) => c.status === 'error' && /doctor-memtest.*missing env.*MEM0_API_KEY/.test(c.message)));
});

test('doctor: an account with an existing non-empty config dir reports ok', async () => {
  const acct = addAccount('doctor-work', 'claude');
  fs.writeFileSync(path.join(acct.config_dir, 'settings.json'), '{}');
  const { checks } = await runDoctor();
  assert.ok(checks.some((c) => c.status === 'ok' && c.message.includes('doctor-work') && c.message.includes('non-empty')));
});

test('doctor: reports daemon not running when no pidfile exists', async () => {
  const { checks } = await runDoctor();
  assert.ok(checks.some((c) => c.status === 'warn' && /daemon not running/.test(c.message)));
});
