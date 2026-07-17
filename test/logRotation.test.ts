import { test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

process.env.SPARELOOP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'spareloop-logrotate-'));

import { log } from '../src/daemon/loop';
import { daemonLogPath, ensureDirs } from '../src/core/paths';

test('log(): rotates (truncates to recent lines) once the daemon log exceeds the size threshold', () => {
  ensureDirs();
  // Write an oversized log file directly (fast) rather than calling log()
  // tens of thousands of times.
  const bigLine = 'x'.repeat(200) + '\n';
  const linesNeeded = Math.ceil((11 * 1024 * 1024) / bigLine.length); // > 10MB threshold
  const fd = fs.openSync(daemonLogPath(), 'w');
  for (let i = 0; i < linesNeeded; i++) fs.writeSync(fd, `line-${i}-${bigLine}`);
  fs.closeSync(fd);

  const sizeBefore = fs.statSync(daemonLogPath()).size;
  assert.ok(sizeBefore > 10 * 1024 * 1024);

  log('marker-after-rotation');

  const sizeAfter = fs.statSync(daemonLogPath()).size;
  assert.ok(sizeAfter < sizeBefore, 'log file should have shrunk after rotation');

  const content = fs.readFileSync(daemonLogPath(), 'utf8');
  assert.match(content, /marker-after-rotation/);
  // Rotation keeps the most recent lines - the very first line written should be gone.
  assert.ok(!content.includes('line-0-'), 'oldest lines should have been dropped by rotation');
});
