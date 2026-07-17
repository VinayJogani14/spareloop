import { AccountRow, getAccount, listAccounts } from '../accounts';
import { getAdapter } from '../../adapters/registry';
import { latestRateLimit, TaskRow } from '../repo';
import { coolOffMsForUnparseableReset } from '../../adapters/resetParser';
import { ToolName } from '../../adapters/types';

export type RouteResult =
  | { kind: 'default' } // run with the user's normal login, no env override
  | { kind: 'account'; account: AccountRow }
  // Temporary: every candidate is currently rate-limited. Keep retrying -
  // the daemon's rate-limit recovery pass will re-queue once a reset passes.
  | { kind: 'unavailable'; reason: string }
  // Permanent: the task can never succeed as configured (typo'd/removed
  // account, wrong tool). Retrying forever would just spam the log every
  // tick - the caller should fail the task instead.
  | { kind: 'misconfigured'; reason: string };

/**
 * Resolve which account a task should run under.
 *  - task.account null      -> default login
 *  - task.account 'auto'    -> first account (by route_order) without an
 *                              active rate-limit block; falls back to the
 *                              default login if no accounts are registered
 *  - task.account '<name>'  -> that account, or unavailable if blocked/missing
 */
export function routeAccount(task: TaskRow, now = new Date()): RouteResult {
  if (task.account == null) return { kind: 'default' };

  if (task.account !== 'auto') {
    const acct = getAccount(task.account);
    if (!acct) return { kind: 'misconfigured', reason: `account "${task.account}" not found` };
    if (acct.tool !== task.tool)
      return { kind: 'misconfigured', reason: `account "${acct.name}" is a ${acct.tool} account, task is ${task.tool}` };
    return isBlocked(task.tool, acct.name, now)
      ? { kind: 'unavailable', reason: `account "${acct.name}" is rate-limited` }
      : { kind: 'account', account: acct };
  }

  const candidates = listAccounts(task.tool) as AccountRow[];
  if (candidates.length === 0) {
    // 'auto' with no registered accounts degrades gracefully to the default login.
    return isBlocked(task.tool, null, now)
      ? { kind: 'unavailable', reason: 'default login is rate-limited and no accounts are registered' }
      : { kind: 'default' };
  }
  for (const acct of candidates) {
    if (!isBlocked(task.tool, acct.name, now)) return { kind: 'account', account: acct };
  }
  return { kind: 'unavailable', reason: `all ${candidates.length} ${task.tool} account(s) are rate-limited` };
}

function isBlocked(tool: ToolName, account: string | null, now: Date): boolean {
  if (!getAdapter(tool).capabilities.hasRollingWindow) return false;
  const hit = latestRateLimit(tool, account);
  if (!hit) return false;
  if (hit.rate_limit_reset_at) {
    const reset = new Date(hit.rate_limit_reset_at);
    return !isNaN(reset.getTime()) && reset > now;
  }
  const coolOff = coolOffMsForUnparseableReset(hit.raw_ref ?? '');
  return new Date(hit.occurred_at).getTime() + coolOff > now.getTime();
}
