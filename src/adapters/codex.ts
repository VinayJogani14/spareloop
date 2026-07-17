import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import {
  NewUsageEvent,
  RollingWindowAdapter,
  RunOptions,
  RunOutcome,
  ToolCapabilities,
} from './types';
import { spawnCapture, commandExists } from './spawn';
import { looksRateLimited, parseResetPhrase } from './resetParser';
import { estimateCostUsd } from './pricing';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Adapter for OpenAI Codex CLI headless mode (`codex exec`).
 * Reports tokens via NDJSON `turn.completed` events but no dollar cost —
 * cost is estimated from the pricing table and flagged as estimated.
 */
export class CodexAdapter implements RollingWindowAdapter {
  readonly tool = 'codex' as const;
  readonly binName = 'codex';
  readonly capabilities: ToolCapabilities = {
    hasRollingWindow: true,
    reportsDollarCost: false,
    reportsTokens: true,
    // `codex exec resume` exists but headless-resume semantics are unverified;
    // enable once validated against a real install.
    supportsSessionResume: false,
  };

  buildArgs(opts: RunOptions): string[] {
    const args = ['exec', opts.prompt, '--json'];
    if (opts.model) args.push('--model', opts.model);
    if (opts.permissionMode === 'full_bypass') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      args.push('-a', 'never', '-s', 'workspace-write');
    }
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
        rawMessage: combined
          .split('\n')
          .find((l) => looksRateLimited(l))
          ?.trim()
          .slice(0, 500) ?? '',
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

    // Sum usage across all turn.completed NDJSON events.
    let input = 0,
      cachedInput = 0,
      output = 0,
      reasoning = 0;
    let sessionId: string | null = null;
    let sawUsage = false;
    for (const line of res.stdout.split('\n')) {
      const evt = safeParse(line);
      if (!evt) continue;
      if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
        sessionId = evt.thread_id;
      }
      const usage = evt.type === 'turn.completed' ? evt.usage : null;
      if (usage) {
        sawUsage = true;
        input += usage.input_tokens ?? 0;
        cachedInput += usage.cached_input_tokens ?? 0;
        output += usage.output_tokens ?? 0;
        reasoning += usage.reasoning_output_tokens ?? 0;
      }
    }

    return {
      kind: 'success',
      metrics: {
        costUsd: sawUsage ? estimateCostUsd(opts.model ?? null, input, output, cachedInput) : null,
        costUsdEstimated: true,
        inputTokens: sawUsage ? input : null,
        outputTokens: sawUsage ? output : null,
        cachedInputTokens: sawUsage ? cachedInput : null,
        reasoningOutputTokens: sawUsage ? reasoning : null,
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
   * Tail $CODEX_HOME/sessions JSONL transcripts. Schema is community-documented
   * (not officially guaranteed), so parse defensively: only token_count events.
   */
  async ingestInteractiveUsage(
    cursor: string | null
  ): Promise<{ events: NewUsageEvent[]; newCursor: string | null }> {
    const sessionsDir = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
    if (!fs.existsSync(sessionsDir)) return { events: [], newCursor: cursor };

    const offsets: Record<string, number> = cursor ? safeParse(cursor) ?? {} : {};
    const events: NewUsageEvent[] = [];
    const cutoff = Date.now() - 35 * 24 * 3600 * 1000;

    for (const file of walkJsonl(sessionsDir)) {
      const stat = fs.statSync(file);
      if (stat.mtimeMs < cutoff) continue;
      const prev = offsets[file] ?? 0;
      if (stat.size <= prev) {
        if (stat.size < prev) offsets[file] = 0;
        continue;
      }
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(stat.size - prev);
      fs.readSync(fd, buf, 0, buf.length, prev);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      if (lastNewline === -1) continue;
      offsets[file] = prev + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');

      for (const line of text.slice(0, lastNewline).split('\n')) {
        const obj = safeParse(line);
        if (!obj) continue;
        const info = obj?.payload?.info ?? obj?.payload;
        const tokens =
          obj?.payload?.type === 'token_count'
            ? info?.last_token_usage ?? info?.total_token_usage ?? null
            : null;
        const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
        if (!tokens || !ts) continue;
        events.push({
          tool: 'codex',
          source: 'interactive',
          occurredAt: ts,
          sessionId: null,
          costUsd: null,
          costUsdEstimated: false,
          inputTokens: numOrNull(tokens.input_tokens),
          outputTokens: numOrNull(tokens.output_tokens),
          cachedInputTokens: numOrNull(tokens.cached_input_tokens),
          rateLimitHit: false,
          rateLimitResetAt: null,
          rawRef: file,
        });
      }
    }
    return { events, newCursor: JSON.stringify(offsets) };
  }

  async detectInstallation() {
    const res = await commandExists(this.binName);
    return { installed: res.found, version: res.version };
  }
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(full));
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
