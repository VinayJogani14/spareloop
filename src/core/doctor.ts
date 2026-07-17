import * as fs from 'fs';
import { allAdapters, getAdapter } from '../adapters/registry';
import { listAccounts, envForAccount } from './accounts';
import { listTasks, TaskRow } from './repo';
import { listProfiles } from './profiles';
import { routeAccount } from './scheduler/accountRouter';
import { missingEnvFor } from './memory';
import { readDaemonPid } from '../daemon/index';
import { dataDir } from './paths';

export type CheckStatus = 'ok' | 'warn' | 'error';
export interface DoctorCheck {
  status: CheckStatus;
  message: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

/**
 * Read-only diagnostic pass: daemon health, per-tool CLI availability,
 * per-account config-dir sanity, misconfigured tasks (the exact bug class
 * that used to retry silently forever - see accountRouter.ts's
 * 'misconfigured' vs 'unavailable' distinction), and memory-provider env.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // Data directory
  try {
    fs.accessSync(dataDir(), fs.constants.W_OK);
    checks.push({ status: 'ok', message: `data dir writable: ${dataDir()}` });
  } catch {
    checks.push({ status: 'error', message: `data dir not writable: ${dataDir()}` });
  }

  // Daemon
  const pid = readDaemonPid();
  checks.push(
    pid
      ? { status: 'ok', message: `daemon running (pid ${pid})` }
      : { status: 'warn', message: 'daemon not running — queued tasks and prewarm will not fire (spareloop daemon install)' }
  );

  // Tool installation
  for (const adapter of allAdapters()) {
    const det = await adapter.detectInstallation();
    checks.push(
      det.installed
        ? { status: 'ok', message: `${adapter.tool}: installed (${det.version ?? 'unknown version'})` }
        : { status: 'warn', message: `${adapter.tool}: not found on PATH — tasks for this tool cannot run` }
    );
  }

  // Accounts: config dir exists, tool installed
  for (const acct of listAccounts()) {
    if (!fs.existsSync(acct.config_dir)) {
      checks.push({ status: 'error', message: `account "${acct.name}" (${acct.tool}): config dir missing: ${acct.config_dir}` });
      continue;
    }
    const authFilesPresent = fs.readdirSync(acct.config_dir).length > 0;
    checks.push(
      authFilesPresent
        ? { status: 'ok', message: `account "${acct.name}" (${acct.tool}): config dir present and non-empty` }
        : {
            status: 'warn',
            message: `account "${acct.name}" (${acct.tool}): config dir exists but looks empty — probably not logged in yet (spareloop account login ${acct.name})`,
          }
    );
    if (!getAdapter(acct.tool).capabilities) continue;
    void envForAccount(acct); // exercised for side-effect-free validation; env shape checked by TS
  }

  // Misconfigured tasks: same class of bug as the removed-account fix -
  // reuse routeAccount directly so this stays in sync with the real gate.
  const pending = listTasks({ status: 'queued' }).concat(listTasks({ status: 'rate_limited' }));
  const misconfigured = pending.filter((t: TaskRow) => routeAccount(t).kind === 'misconfigured');
  if (misconfigured.length > 0) {
    for (const t of misconfigured) {
      const route = routeAccount(t);
      checks.push({
        status: 'error',
        message: `task ${t.id.slice(0, 8)} is misconfigured and will never run: ${route.kind === 'misconfigured' ? route.reason : ''}`,
      });
    }
  } else if (pending.length > 0) {
    checks.push({ status: 'ok', message: `${pending.length} queued/rate-limited task(s), all routable` });
  }

  // Memory providers: profiles with missing env
  for (const p of listProfiles()) {
    if (!p.memory_provider) continue;
    const missing = missingEnvFor(p.memory_provider);
    checks.push(
      missing.length === 0
        ? { status: 'ok', message: `profile "${p.name}": memory provider "${p.memory_provider}" env ok` }
        : {
            status: 'error',
            message: `profile "${p.name}": memory provider "${p.memory_provider}" missing env: ${missing.join(', ')}`,
          }
    );
  }

  return { checks };
}
