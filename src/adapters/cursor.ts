import { randomUUID } from 'crypto';
import { CliAdapter, NewUsageEvent, RunOptions, RunOutcome, ToolCapabilities } from './types';
import { spawnCapture, commandExists } from './spawn';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Adapter for Cursor CLI headless mode (`cursor-agent -p`).
 *
 * Honest about its limits: Cursor's local CLI JSON output contains NO token or
 * cost fields, and Cursor bills from a monthly credit pool rather than a
 * rolling window — so this adapter reports no metrics (never fabricates them),
 * implements no rolling-window behavior, and is excluded from prewarm logic
 * at the type level (does not implement RollingWindowAdapter).
 */
export class CursorAdapter implements CliAdapter {
  readonly tool = 'cursor' as const;
  readonly binName = 'cursor-agent';
  readonly capabilities: ToolCapabilities = {
    hasRollingWindow: false,
    reportsDollarCost: false,
    reportsTokens: false,
  };

  buildArgs(opts: RunOptions): string[] {
    const args = ['-p', opts.prompt, '--output-format', 'json'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.permissionMode === 'full_bypass') {
      args.push('--force');
    }
    // allowlist mode: rely on the user's ~/.cursor/cli-config.json permission
    // rules; commands outside them fail rather than hang on an approval prompt.
    args.push('--trust');
    if (opts.extraArgs) args.push(...opts.extraArgs);
    return args;
  }

  async run(opts: RunOptions): Promise<RunOutcome> {
    const runId = randomUUID();
    const res = await spawnCapture(
      this.binName,
      this.buildArgs(opts),
      opts.projectDir,
      runId,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    if (res.timedOut) return { kind: 'timeout', stdoutLogPath: res.stdoutLogPath };

    let isError = res.exitCode !== 0;
    let sessionId: string | null = null;
    try {
      const parsed = JSON.parse(res.stdout);
      if (parsed.is_error === true) isError = true;
      if (typeof parsed.session_id === 'string') sessionId = parsed.session_id;
    } catch {
      // Non-JSON output: fall back to exit code alone.
    }

    if (isError) {
      return {
        kind: 'failure',
        exitCode: res.exitCode,
        errorMessage: (res.stderr || res.stdout).slice(0, 2000),
        stdoutLogPath: res.stdoutLogPath,
        stderrLogPath: res.stderrLogPath,
      };
    }

    return {
      kind: 'success',
      metrics: {
        costUsd: null,
        costUsdEstimated: false,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
        sessionId,
        durationMs: res.durationMs,
      },
      stdoutLogPath: res.stdoutLogPath,
    };
  }

  /** No known local session log exposing usage — nothing to ingest. */
  async ingestInteractiveUsage(
    cursor: string | null
  ): Promise<{ events: NewUsageEvent[]; newCursor: string | null }> {
    return { events: [], newCursor: cursor };
  }

  async detectInstallation() {
    const res = await commandExists(this.binName);
    return {
      installed: res.found,
      version: res.version,
      note: res.found
        ? 'Cursor bills from a monthly credit pool; spareloop tracks run counts only (no token/cost data in local CLI).'
        : undefined,
    };
  }
}
