import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runLogsDir } from '../core/paths';

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  stdoutLogPath: string;
  stderrLogPath: string;
}

const MAX_INLINE_CAPTURE = 4 * 1024 * 1024; // keep at most 4MB in memory for parsing

/**
 * Spawn a CLI subprocess, stream stdout/stderr to per-run log files,
 * and keep a bounded in-memory copy for parsing.
 */
export function spawnCapture(
  bin: string,
  args: string[],
  cwd: string,
  runId: string,
  timeoutMs: number
): Promise<SpawnResult> {
  const stdoutLogPath = path.join(runLogsDir(), `${runId}.stdout.log`);
  const stderrLogPath = path.join(runLogsDir(), `${runId}.stderr.log`);
  const outStream = fs.createWriteStream(stdoutLogPath);
  const errStream = fs.createWriteStream(stderrLogPath);
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      outStream.write(chunk);
      if (stdout.length < MAX_INLINE_CAPTURE) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errStream.write(chunk);
      if (stderr.length < MAX_INLINE_CAPTURE) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      outStream.end();
      errStream.end();
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr + `\n[spareloop] spawn error: ${err.message}`,
        timedOut,
        durationMs: Date.now() - start,
        stdoutLogPath,
        stderrLogPath,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      outStream.end();
      errStream.end();
      resolve({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
        stdoutLogPath,
        stderrLogPath,
      });
    });
  });
}

export function commandExists(bin: string): Promise<{ found: boolean; version?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', () => resolve({ found: false }));
    child.on('close', (code) =>
      resolve(code === 0 ? { found: true, version: out.trim().split('\n')[0] } : { found: false })
    );
  });
}
