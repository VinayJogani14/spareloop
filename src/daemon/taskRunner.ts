import { getAdapter } from '../adapters/registry';
import { NewUsageEvent, RunOptions } from '../adapters/types';
import {
  bumpAttempt,
  finishRun,
  insertRun,
  insertUsageEvents,
  successfulSessionId,
  TaskRow,
  updateTaskStatus,
} from '../core/repo';
import { coolOffMsForUnparseableReset } from '../adapters/resetParser';
import { envForAccount } from '../core/accounts';
import { routeAccount } from '../core/scheduler/accountRouter';
import { commitWorktreeChanges, isLargeCommit, prepareWorkspace } from '../core/git';
import { getDb } from '../core/db';
import { notify } from '../notify/index';

export interface LaunchResult {
  runId: string;
  outcomeKind: 'success' | 'failure' | 'rate_limited' | 'timeout' | 'skipped';
}

/** Instructions preamble + task prompt -> what the agent actually receives. */
export function buildEffectivePrompt(instructions: string | null, prompt: string): string {
  if (!instructions || !instructions.trim()) return prompt;
  return `${instructions.trim()}\n\n---\n\n${prompt}`;
}

/** Resolve the session to resume: explicit --continue-from beats chain --same-session. */
export function resolveResumeSession(task: TaskRow): string | null {
  if (task.resume_session_id) return task.resume_session_id;
  if (task.same_session === 1 && task.depends_on) return successfulSessionId(task.depends_on);
  return null;
}

/**
 * Execute one attempt of a task: route it to an account, prepare an isolated
 * workspace (git worktree for repos), spawn the CLI, record the run, feed the
 * unified usage timeline, and transition the task's status.
 */
export async function executeTask(task: TaskRow, log: (msg: string) => void): Promise<LaunchResult> {
  const adapter = getAdapter(task.tool);

  const route = routeAccount(task);
  if (route.kind === 'misconfigured') {
    // Permanent problem (bad/removed account, wrong tool) — retrying every
    // tick forever would never resolve it. Fail fast instead.
    updateTaskStatus(task.id, 'failed');
    log(`task ${task.id.slice(0, 8)} failed: ${route.reason}`);
    return { runId: '', outcomeKind: 'skipped' };
  }
  if (route.kind === 'unavailable') {
    // Temporary — every candidate account is currently rate-limited. Not an
    // attempt; stays queued and the daemon's recovery pass retries later.
    log(`task ${task.id.slice(0, 8)} not launchable right now: ${route.reason}`);
    return { runId: '', outcomeKind: 'skipped' };
  }
  const accountName = route.kind === 'account' ? route.account.name : null;
  const env = route.kind === 'account' ? envForAccount(route.account) : undefined;

  const resumeSessionId = resolveResumeSession(task);
  if (resumeSessionId && !adapter.capabilities.supportsSessionResume) {
    log(`task ${task.id.slice(0, 8)}: ${task.tool} cannot resume sessions headlessly; starting fresh`);
  }

  const ws = prepareWorkspace(task.id, task.project_dir, task.is_prewarm ? 'none' : task.branch_mode, log);

  bumpAttempt(task.id);
  const attempt = task.attempt_count + 1;
  const runId = insertRun(task.id, attempt, task.tool);
  getDb()
    .prepare('UPDATE task_runs SET account = ?, git_branch = ?, worktree_path = ? WHERE id = ?')
    .run(accountName, ws.gitBranch, ws.worktreePath, runId);
  updateTaskStatus(task.id, 'running');
  log(
    `task ${task.id.slice(0, 8)} attempt ${attempt}/${task.max_attempts} starting ` +
      `(${task.tool}${accountName ? `@${accountName}` : ''} in ${ws.runDir}` +
      `${ws.gitBranch ? ` on ${ws.gitBranch}` : ''}${resumeSessionId ? ', resuming session' : ''})`
  );

  const opts: RunOptions = {
    prompt: buildEffectivePrompt(task.instructions, task.prompt),
    projectDir: ws.runDir,
    model: task.model ?? undefined,
    permissionMode: task.permission_mode,
    extraArgs: task.extra_args_json ? JSON.parse(task.extra_args_json) : undefined,
    budgetUsdCap: task.budget_usd_cap ?? undefined,
    env,
    resumeSessionId:
      resumeSessionId && adapter.capabilities.supportsSessionResume ? resumeSessionId : undefined,
  };

  const outcome = await adapter.run(opts);

  if (ws.worktreePath) {
    const result = commitWorktreeChanges(
      ws.worktreePath,
      `spareloop: attempt ${attempt} (${outcome.kind}) - ${task.prompt.slice(0, 72)}`
    );
    if (result.committed) {
      log(`task ${task.id.slice(0, 8)} changes committed to ${ws.gitBranch} (${result.fileCount} file(s))`);
      if (isLargeCommit(result.fileCount)) {
        log(
          `  warning: ${result.fileCount} files is unusually large for one task - check this isn't a ` +
            `swept-in build artifact (node_modules, dist, etc) before merging ${ws.gitBranch}`
        );
      }
    }
  }

  const usageBase: Omit<NewUsageEvent, 'rateLimitHit' | 'rateLimitResetAt'> = {
    tool: task.tool,
    source: task.is_prewarm ? 'prewarm' : 'queued_task',
    occurredAt: new Date().toISOString(),
    sessionId: null,
    costUsd: null,
    costUsdEstimated: false,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    rawRef: null,
    account: accountName,
  };

  switch (outcome.kind) {
    case 'success': {
      finishRun(runId, { outcome: 'success', exitCode: 0, metrics: outcome.metrics, stdoutLogPath: outcome.stdoutLogPath });
      updateTaskStatus(task.id, 'succeeded');
      insertUsageEvents(
        [
          {
            ...usageBase,
            sessionId: outcome.metrics.sessionId,
            costUsd: outcome.metrics.costUsd,
            costUsdEstimated: outcome.metrics.costUsdEstimated,
            inputTokens: outcome.metrics.inputTokens,
            outputTokens: outcome.metrics.outputTokens,
            cachedInputTokens: outcome.metrics.cachedInputTokens,
            rateLimitHit: false,
            rateLimitResetAt: null,
          },
        ],
        runId
      );
      log(
        `task ${task.id.slice(0, 8)} succeeded` +
          (outcome.metrics.costUsd != null
            ? ` ($${outcome.metrics.costUsd.toFixed(4)}${outcome.metrics.costUsdEstimated ? ' est' : ''})`
            : '') +
          (ws.gitBranch ? ` — review: git checkout ${ws.gitBranch}` : '')
      );
      if (!task.is_prewarm) {
        notify(
          'spareloop: task succeeded',
          `${task.prompt.slice(0, 80)}${ws.gitBranch ? ` (branch ${ws.gitBranch})` : ''}`
        );
      }
      return { runId, outcomeKind: 'success' };
    }
    case 'rate_limited': {
      const resetIso = outcome.resetAt ? outcome.resetAt.toISOString() : null;
      finishRun(runId, {
        outcome: 'rate_limited',
        metrics: outcome.metrics,
        rateLimitMessage: outcome.rawMessage,
        rateLimitResetAt: resetIso,
        stdoutLogPath: outcome.stdoutLogPath,
      });
      insertUsageEvents(
        [{ ...usageBase, rateLimitHit: true, rateLimitResetAt: resetIso, rawRef: outcome.rawMessage }],
        runId
      );
      if (attempt < task.max_attempts) {
        const notBefore = outcome.resetAt
          ? new Date(outcome.resetAt.getTime() + 60_000)
          : new Date(Date.now() + coolOffMsForUnparseableReset(outcome.rawMessage));
        updateTaskStatus(task.id, 'rate_limited', { notBefore: notBefore.toISOString() });
        log(`task ${task.id.slice(0, 8)} rate-limited; will retry after ${notBefore.toISOString()}`);
      } else {
        updateTaskStatus(task.id, 'failed');
        log(`task ${task.id.slice(0, 8)} rate-limited on final attempt; marking failed`);
        if (!task.is_prewarm) notify('spareloop: task failed (rate limited)', task.prompt.slice(0, 100));
      }
      return { runId, outcomeKind: 'rate_limited' };
    }
    case 'timeout': {
      finishRun(runId, { outcome: 'timeout', stdoutLogPath: outcome.stdoutLogPath });
      updateTaskStatus(task.id, attempt < task.max_attempts ? 'queued' : 'failed');
      log(`task ${task.id.slice(0, 8)} timed out (attempt ${attempt})`);
      return { runId, outcomeKind: 'timeout' };
    }
    case 'failure': {
      finishRun(runId, {
        outcome: 'failure',
        exitCode: outcome.exitCode,
        errorMessage: outcome.errorMessage,
        stdoutLogPath: outcome.stdoutLogPath,
        stderrLogPath: outcome.stderrLogPath,
      });
      const willRetry = attempt < task.max_attempts;
      updateTaskStatus(task.id, willRetry ? 'queued' : 'failed');
      log(`task ${task.id.slice(0, 8)} failed (exit ${outcome.exitCode}): ${outcome.errorMessage.slice(0, 200)}`);
      if (!willRetry && !task.is_prewarm) {
        notify('spareloop: task failed', `${task.prompt.slice(0, 80)} — ${outcome.errorMessage.slice(0, 100)}`);
      }
      return { runId, outcomeKind: 'failure' };
    }
  }
}
