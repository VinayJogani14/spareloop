import * as fs from 'fs';
import { ensureDirs, pidFilePath } from '../core/paths';
import { drainInFlight, log, tick } from './loop';

const TICK_INTERVAL_MS = 60 * 1000;

/** Persistent daemon: tick every minute until signalled to stop. */
export async function runDaemon(): Promise<void> {
  ensureDirs();
  // Double-daemon guard: launchd/systemd restarts plus a manual `daemon start`
  // must never run two schedulers (they would double-launch tasks).
  const existing = readDaemonPid();
  if (existing !== null && existing !== process.pid) {
    log(`refusing to start: another daemon is already running (pid ${existing})`);
    console.error(`spareloop daemon already running (pid ${existing}); stop it first with: spareloop daemon stop`);
    process.exit(1);
  }
  fs.writeFileSync(pidFilePath(), String(process.pid));
  log(`spareloop daemon started (pid ${process.pid})`);

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log(`received ${sig}; draining in-flight tasks...`);
    await drainInFlight();
    try {
      fs.unlinkSync(pidFilePath());
    } catch {
      /* already gone */
    }
    log('daemon stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  for (;;) {
    if (stopping) break;
    try {
      await tick();
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }
    await sleep(TICK_INTERVAL_MS);
  }
}

/** Stateless one-shot pass, for the cron fallback backend. */
export async function runSingleTick(): Promise<void> {
  ensureDirs();
  await tick();
  await drainInFlight();
}

export function readDaemonPid(): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFilePath(), 'utf8').trim(), 10);
    if (!Number.isFinite(pid)) return null;
    process.kill(pid, 0); // existence check only
    return pid;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
