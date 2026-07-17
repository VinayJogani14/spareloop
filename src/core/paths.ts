import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

export function dataDir(): string {
  const override = process.env.SPARELOOP_HOME;
  if (override) return override;
  return path.join(os.homedir(), '.local', 'share', 'spareloop');
}

export function dbPath(): string {
  return path.join(dataDir(), 'spareloop.db');
}

export function logsDir(): string {
  return path.join(dataDir(), 'logs');
}

export function runLogsDir(): string {
  return path.join(logsDir(), 'runs');
}

export function pidFilePath(): string {
  return path.join(dataDir(), 'daemon.pid');
}

export function daemonLogPath(): string {
  return path.join(logsDir(), 'daemon.log');
}

export function ensureDirs(): void {
  for (const d of [dataDir(), logsDir(), runLogsDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
}
