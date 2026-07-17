import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-memory-'));

import { buildMemoryExtraArgs, missingEnvFor, listMemoryProviders, getMemoryProvider } from '../src/core/memory';
import { addProfile, getProfile } from '../src/core/profiles';
import { insertTask, getTask } from '../src/core/repo';
import { ClaudeAdapter } from '../src/adapters/claude';
import { CodexAdapter } from '../src/adapters/codex';
import { CursorAdapter } from '../src/adapters/cursor';

test('memory provider registry: mem0 and supermemory are registered with required env declared', () => {
  const providers = listMemoryProviders();
  assert.ok(providers.some((p) => p.name === 'mem0'));
  assert.ok(providers.some((p) => p.name === 'supermemory'));
  assert.deepEqual(getMemoryProvider('mem0')!.requiredEnv, ['MEM0_API_KEY']);
});

test('missingEnvFor detects absent env vars and clears once set', () => {
  delete process.env.MEM0_API_KEY;
  assert.deepEqual(missingEnvFor('mem0'), ['MEM0_API_KEY']);
  process.env.MEM0_API_KEY = 'test-key-123';
  assert.deepEqual(missingEnvFor('mem0'), []);
});

test('buildMemoryExtraArgs produces a valid --mcp-config JSON pair with the auth header embedded', () => {
  process.env.MEM0_API_KEY = 'secret-abc';
  const args = buildMemoryExtraArgs('mem0');
  assert.equal(args[0], '--mcp-config');
  const config = JSON.parse(args[1]);
  assert.equal(config.mcpServers.mem0.type, 'http');
  assert.equal(config.mcpServers.mem0.url, 'https://mcp.mem0.ai/mcp');
  assert.equal(config.mcpServers.mem0.headers.Authorization, 'Bearer secret-abc');
});

test('capability gate: only Claude supports memory injection, Codex and Cursor do not', () => {
  assert.equal(new ClaudeAdapter().capabilities.supportsMemoryInjection, true);
  assert.equal(new CodexAdapter().capabilities.supportsMemoryInjection, false);
  assert.equal(new CursorAdapter().capabilities.supportsMemoryInjection, false);
});

test('profile with memory_provider flows through to a task\'s extraArgs end-to-end', () => {
  process.env.MEM0_API_KEY = 'secret-xyz';
  addProfile({
    name: 'with-memory',
    tool: 'claude',
    projectDir: os.tmpdir(),
    memoryProvider: 'mem0',
  });
  const profile = getProfile('with-memory')!;
  assert.equal(profile.memory_provider, 'mem0');

  const extraArgs = buildMemoryExtraArgs(profile.memory_provider!);
  const taskId = insertTask({
    prompt: 'test',
    tool: 'claude',
    projectDir: os.tmpdir(),
    scheduleKind: 'asap',
    extraArgs,
    profileId: profile.id,
  });
  const task = getTask(taskId)!;
  const parsed = JSON.parse(task.extra_args_json!);
  assert.equal(parsed[0], '--mcp-config');
  assert.match(parsed[1], /mcp\.mem0\.ai/);
});
