import { getAdapter } from '../adapters/registry';
import { NewUsageEvent, RunOptions } from '../adapters/types';
import {
  bumpAttempt,
  finishRun,
  insertRun,
  insertUsageEvents,
  TaskRow,
  updateTaskStatus,
} from '../core/repo';
import { coolOffMsForUnparseableReset } from '../adapters/resetParser';

export interface LaunchResult {
  runId: string;
  outcomeKind: 'success' | 'failure' | 'rate_limited' | 'timeout';
}

/**
 * Execute one attempt of a task: spawn the CLI, record the run, feed the
 * unified usage timeline, and transition the task's status (including
 * automatic reschedule-after-reset on a rate-limit hit).
 */
export async function executeTask(task: TaskRow, log: (msg: string) => void): Promise<LaunchResult> {
  const adapter = getAdapter(task.tool);
  bumpAttempt(task.id);
  const attempt = task.attempt_count + 1;
  const runId = insertRun(task.id, attempt, task.tool);
  updateTaskStatus(task.id, 'running');
  log(`task ${task.id.slice(0, 8)} attempt ${attempt}/${task.max_attempts} starting (${task.tool} in ${task.project_dir})`);

  const opts: RunOptions = {
    prompt: task.prompt,
    projectDir: task.project_dir,
    model: task.model ?? undefined,
    permissionMode: task.permission_mode,
    extraArgs: task.extra_args_json ? JSON.parse(task.extra_args_json) : undefined,
    budgetUsdCap: task.budget_usd_cap ?? undefined,
  };

  const outcome = await adapter.run(opts);

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
      log(`task ${task.id.slice(0, 8)} succeeded` + (outcome.metrics.costUsd != null ? ` ($${outcome.metrics.costUsd.toFixed(4)}${outcome.metrics.costUsdEstimated ? ' est' : ''})` : ''));
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
        // Requeue with not_before pushed past the reset (plus a safety margin);
        // when the reset time couldn't be parsed, back off 3h for a window hit
        // or 24h for a weekly cap.
        const notBefore = outcome.resetAt
          ? new Date(outcome.resetAt.getTime() + 60_000)
          : new Date(Date.now() + coolOffMsForUnparseableReset(outcome.rawMessage));
        updateTaskStatus(task.id, 'rate_limited', { notBefore: notBefore.toISOString() });
        log(`task ${task.id.slice(0, 8)} rate-limited; will retry after ${notBefore.toISOString()}`);
      } else {
        updateTaskStatus(task.id, 'failed');
        log(`task ${task.id.slice(0, 8)} rate-limited on final attempt; marking failed`);
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
      updateTaskStatus(task.id, attempt < task.max_attempts ? 'queued' : 'failed');
      log(`task ${task.id.slice(0, 8)} failed (exit ${outcome.exitCode}): ${outcome.errorMessage.slice(0, 200)}`);
      return { runId, outcomeKind: 'failure' };
    }
  }
}
