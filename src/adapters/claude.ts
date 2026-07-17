import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  CliAdapter,
  NewUsageEvent,
  RollingWindowAdapter,
  RunOptions,
  RunOutcome,
  ToolCapabilities,
} from './types';
import { spawnCapture, commandExists } from './spawn';
import { looksRateLimited, parseResetPhrase } from './resetParser';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 1h per task

/**
 * Adapter for Claude Code headless mode (`claude -p`).
 * Richest signal of the three tools: native dollar cost, tokens, session id.
 */
export class ClaudeAdapter implements RollingWindowAdapter {
  readonly tool = 'claude' as const;
  readonly binName = 'claude';
  readonly capabilities: ToolCapabilities = {
    hasRollingWindow: true,
    reportsDollarCost: true,
    reportsTokens: true,
    supportsSessionResume: true,
  };

  buildArgs(opts: RunOptions): string[] {
    const args = ['-p', opts.prompt, '--output-format', 'json'];
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    if (opts.model) args.push('--model', opts.model);
    if (opts.permissionMode === 'full_bypass') {
      args.push('--dangerously-skip-permissions');
    } else {
      // Safe default: never prompts, auto-denies anything outside the
      // permissions.allow rules configured in the target project's settings.
      args.push('--permission-mode', 'dontAsk');
    }
    if (opts.budgetUsdCap != null) args.push('--max-budget-usd', String(opts.budgetUsdCap));
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
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      opts.env
    );

    if (res.timedOut) return { kind: 'timeout', stdoutLogPath: res.stdoutLogPath };

    const combined = res.stdout + '\n' + res.stderr;

    if (res.exitCode !== 0 && looksRateLimited(combined)) {
      return {
        kind: 'rate_limited',
        metrics: { durationMs: res.durationMs },
        resetAt: this.parseRateLimitReset(combined, new Date()),
        rawMessage: firstRateLimitLine(combined),
        stdoutLogPath: res.stdoutLogPath,
      };
    }

    if (res.exitCode !== 0) {
      return {
        kind: 'failure',
        exitCode: res.exitCode,
        errorMessage: res.stderr.slice(0, 2000) || 'non-zero exit',
        stdoutLogPath: res.stdoutLogPath,
        stderrLogPath: res.stderrLogPath,
      };
    }

    let costUsd: number | null = null;
    let sessionId: string | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cachedInputTokens: number | null = null;
    try {
      const parsed = JSON.parse(res.stdout);
      costUsd = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
      sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
      const usage = parsed.usage ?? parsed.modelUsage ?? null;
      if (usage && typeof usage === 'object') {
        inputTokens = numOrNull(usage.input_tokens);
        outputTokens = numOrNull(usage.output_tokens);
        cachedInputTokens = numOrNull(usage.cache_read_input_tokens);
      }
    } catch {
      // Output wasn't the expected single JSON object; the run still succeeded.
    }

    return {
      kind: 'success',
      metrics: {
        costUsd,
        costUsdEstimated: false,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        reasoningOutputTokens: null,
        sessionId,
        durationMs: res.durationMs,
      },
      stdoutLogPath: res.stdoutLogPath,
    };
  }

  parseRateLimitReset(message: string, now: Date): Date | null {
    return parseResetPhrase(message, now);
  }

  /**
   * Tail ~/.claude/projects/**\/*.jsonl for interactive session usage.
   * Schema is undocumented and version-fragile, so parsing is defensive:
   * we only take fields we recognize and skip anything else.
   * Cursor format: JSON { files: { [absPath]: lastByteOffset } }
   */
  async ingestInteractiveUsage(
    cursor: string | null
  ): Promise<{ events: NewUsageEvent[]; newCursor: string | null }> {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return { events: [], newCursor: cursor };

    const offsets: Record<string, number> = cursor ? safeParse(cursor) ?? {} : {};
    const events: NewUsageEvent[] = [];
    const cutoff = Date.now() - 35 * 24 * 3600 * 1000; // ignore files idle > 35 days

    for (const file of listJsonlFiles(projectsDir)) {
      const stat = fs.statSync(file);
      if (stat.mtimeMs < cutoff) continue;
      const prevOffset = offsets[file] ?? 0;
      if (stat.size <= prevOffset) {
        // File truncated/rotated: reset; unchanged: skip.
        if (stat.size < prevOffset) offsets[file] = 0;
        continue;
      }

      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(stat.size - prevOffset);
      fs.readSync(fd, buf, 0, buf.length, prevOffset);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) continue; // no complete line yet
      offsets[file] = prevOffset + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');

      for (const line of text.slice(0, lastNewline).split('\n')) {
        const evt = parseClaudeLogLine(line, file);
        if (evt) events.push(evt);
      }
    }

    return { events, newCursor: JSON.stringify({ ...offsets }) };
  }

  async detectInstallation() {
    const res = await commandExists(this.binName);
    return { installed: res.found, version: res.version };
  }
}

function parseClaudeLogLine(line: string, file: string): NewUsageEvent | null {
  if (!line.trim()) return null;
  const obj = safeParse(line);
  if (!obj || typeof obj !== 'object') return null;

  // Assistant turns carry message.usage with token counts.
  const usage = obj?.message?.usage;
  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  if (!ts) return null;

  const isApiError =
    typeof obj?.message?.content === 'string' && looksRateLimited(obj.message.content);
  const textBlocks: string = Array.isArray(obj?.message?.content)
    ? obj.message.content
        .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
        .join('\n')
    : '';
  const rateLimitHit = isApiError || looksRateLimited(textBlocks);

  if (!usage && !rateLimitHit) return null;

  return {
    tool: 'claude',
    source: 'interactive',
    occurredAt: ts,
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
    costUsd: numOrNull(obj.costUSD),
    costUsdEstimated: false,
    inputTokens: numOrNull(usage?.input_tokens),
    outputTokens: numOrNull(usage?.output_tokens),
    cachedInputTokens: numOrNull(usage?.cache_read_input_tokens),
    rateLimitHit,
    rateLimitResetAt: rateLimitHit
      ? parseResetPhrase(textBlocks || String(obj?.message?.content ?? ''), new Date(ts))?.toISOString() ?? null
      : null,
    rawRef: file,
  };
}

function listJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJsonlFiles(full));
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function safeParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function firstRateLimitLine(text: string): string {
  for (const line of text.split('\n')) {
    if (looksRateLimited(line)) return line.trim().slice(0, 500);
  }
  return text.trim().slice(0, 500);
}
