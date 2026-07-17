export type ToolName = 'claude' | 'codex' | 'cursor';

export interface ToolCapabilities {
  /** Tool enforces a rolling usage window (5h) — prewarm + dead-zone logic apply. */
  hasRollingWindow: boolean;
  /** Tool reports dollar cost natively in headless output. */
  reportsDollarCost: boolean;
  /** Tool reports token counts in headless output. */
  reportsTokens: boolean;
  /** Tool can resume a previous session by id in headless mode. */
  supportsSessionResume: boolean;
}

export type PermissionMode = 'allowlist' | 'full_bypass';

export interface RunOptions {
  prompt: string;
  projectDir: string;
  model?: string;
  permissionMode: PermissionMode;
  extraArgs?: string[];
  budgetUsdCap?: number;
  timeoutMs?: number;
  /** Extra environment (e.g. CLAUDE_CONFIG_DIR for account isolation). */
  env?: Record<string, string>;
  /** Resume this prior session instead of starting fresh (capability-gated). */
  resumeSessionId?: string;
}

export interface RunMetrics {
  costUsd: number | null;
  /** true when costUsd was derived by spareloop (tokens x pricing table), not reported by the tool */
  costUsdEstimated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
  sessionId: string | null;
  durationMs: number;
}

export type RunOutcome =
  | { kind: 'success'; metrics: RunMetrics; stdoutLogPath: string }
  | {
      kind: 'rate_limited';
      metrics: Partial<RunMetrics>;
      resetAt: Date | null;
      rawMessage: string;
      stdoutLogPath: string;
    }
  | {
      kind: 'failure';
      exitCode: number | null;
      errorMessage: string;
      stdoutLogPath: string;
      stderrLogPath: string;
    }
  | { kind: 'timeout'; stdoutLogPath: string };

export interface NewUsageEvent {
  tool: ToolName;
  source: 'interactive' | 'queued_task' | 'prewarm';
  occurredAt: string; // ISO
  sessionId: string | null;
  costUsd: number | null;
  costUsdEstimated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  rateLimitHit: boolean;
  rateLimitResetAt: string | null;
  rawRef: string | null;
  /** spareloop-managed account name; null = the user's default login. */
  account?: string | null;
}

export interface CliAdapter {
  readonly tool: ToolName;
  readonly capabilities: ToolCapabilities;
  readonly binName: string;

  buildArgs(opts: RunOptions): string[];
  run(opts: RunOptions): Promise<RunOutcome>;

  /**
   * Parse the tool's own local session logs into normalized usage events.
   * `cursor` is an opaque adapter-owned string marking how far ingestion has progressed.
   */
  ingestInteractiveUsage(
    cursor: string | null
  ): Promise<{ events: NewUsageEvent[]; newCursor: string | null }>;

  detectInstallation(): Promise<{ installed: boolean; version?: string; note?: string }>;
}

/**
 * Implemented ONLY by rolling-window tools (Claude Code, Codex CLI).
 * Cursor uses a monthly credit pool — structurally excluded from window logic.
 */
export interface RollingWindowAdapter extends CliAdapter {
  /** Regex/parse a rate-limit message into an absolute reset time, if possible. */
  parseRateLimitReset(message: string, now: Date): Date | null;
}

export function isRollingWindowAdapter(a: CliAdapter): a is RollingWindowAdapter {
  return a.capabilities.hasRollingWindow;
}
