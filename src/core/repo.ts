import { randomUUID } from 'crypto';
import { getDb } from './db';
import { NewUsageEvent, PermissionMode, RunMetrics, ToolName } from '../adapters/types';

export interface TaskRow {
  id: string;
  prompt: string;
  tool: ToolName;
  project_dir: string;
  model: string | null;
  permission_mode: PermissionMode;
  extra_args_json: string | null;
  profile_id: string | null;
  is_prewarm: number;
  schedule_kind: 'explicit' | 'spare_capacity' | 'asap';
  schedule_at: string | null;
  not_before: string | null;
  not_after: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'rate_limited' | 'expired' | 'cancelled';
  priority: number;
  max_attempts: number;
  attempt_count: number;
  budget_usd_cap: number | null;
  created_at: string;
  updated_at: string;
}

export interface NewTask {
  prompt: string;
  tool: ToolName;
  projectDir: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  extraArgs?: string[];
  profileId?: string | null;
  isPrewarm?: boolean;
  scheduleKind: 'explicit' | 'spare_capacity' | 'asap';
  scheduleAt?: string | null;
  notBefore?: string | null;
  notAfter?: string | null;
  priority?: number;
  maxAttempts?: number;
  budgetUsdCap?: number | null;
}

export function insertTask(t: NewTask): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO tasks (id, prompt, tool, project_dir, model, permission_mode, extra_args_json,
         profile_id, is_prewarm, schedule_kind, schedule_at, not_before, not_after, priority,
         max_attempts, budget_usd_cap)
       VALUES (@id, @prompt, @tool, @projectDir, @model, @permissionMode, @extraArgs,
         @profileId, @isPrewarm, @scheduleKind, @scheduleAt, @notBefore, @notAfter, @priority,
         @maxAttempts, @budgetUsdCap)`
    )
    .run({
      id,
      prompt: t.prompt,
      tool: t.tool,
      projectDir: t.projectDir,
      model: t.model ?? null,
      permissionMode: t.permissionMode ?? 'allowlist',
      extraArgs: t.extraArgs ? JSON.stringify(t.extraArgs) : null,
      profileId: t.profileId ?? null,
      isPrewarm: t.isPrewarm ? 1 : 0,
      scheduleKind: t.scheduleKind,
      scheduleAt: t.scheduleAt ?? null,
      notBefore: t.notBefore ?? null,
      notAfter: t.notAfter ?? null,
      priority: t.priority ?? 0,
      maxAttempts: t.maxAttempts ?? 3,
      budgetUsdCap: t.budgetUsdCap ?? null,
    });
  return id;
}

export function getTask(id: string): TaskRow | undefined {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ? OR id LIKE ?').get(id, `${id}%`) as
    | TaskRow
    | undefined;
}

export function listTasks(filter?: { status?: string; tool?: string }): TaskRow[] {
  let sql = 'SELECT * FROM tasks WHERE 1=1';
  const params: string[] = [];
  if (filter?.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  if (filter?.tool) {
    sql += ' AND tool = ?';
    params.push(filter.tool);
  }
  sql += ' ORDER BY created_at DESC LIMIT 200';
  return getDb().prepare(sql).all(...params) as TaskRow[];
}

export function updateTaskStatus(id: string, status: TaskRow['status'], extra?: { notBefore?: string }): void {
  getDb()
    .prepare(
      `UPDATE tasks SET status = ?, not_before = COALESCE(?, not_before), updated_at = datetime('now') WHERE id = ?`
    )
    .run(status, extra?.notBefore ?? null, id);
}

export function bumpAttempt(id: string): void {
  getDb()
    .prepare(`UPDATE tasks SET attempt_count = attempt_count + 1, updated_at = datetime('now') WHERE id = ?`)
    .run(id);
}

export function insertRun(taskId: string, attempt: number, tool: ToolName): string {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO task_runs (id, task_id, attempt_number, tool) VALUES (?, ?, ?, ?)`)
    .run(id, taskId, attempt, tool);
  return id;
}

export function finishRun(
  runId: string,
  fields: {
    outcome: 'success' | 'failure' | 'rate_limited' | 'timeout' | 'cancelled';
    exitCode?: number | null;
    metrics?: Partial<RunMetrics>;
    rateLimitMessage?: string;
    rateLimitResetAt?: string | null;
    stdoutLogPath?: string;
    stderrLogPath?: string;
    errorMessage?: string;
  }
): void {
  const m = fields.metrics ?? {};
  getDb()
    .prepare(
      `UPDATE task_runs SET ended_at = datetime('now'), outcome = @outcome, exit_code = @exitCode,
        cost_usd = @costUsd, cost_usd_estimated = @costUsdEstimated, input_tokens = @inputTokens,
        output_tokens = @outputTokens, cached_input_tokens = @cachedInputTokens,
        reasoning_output_tokens = @reasoningOutputTokens, session_id = @sessionId,
        duration_ms = @durationMs, rate_limit_message = @rateLimitMessage,
        rate_limit_reset_at = @rateLimitResetAt, stdout_log_path = @stdoutLogPath,
        stderr_log_path = @stderrLogPath, error_message = @errorMessage
       WHERE id = @id`
    )
    .run({
      id: runId,
      outcome: fields.outcome,
      exitCode: fields.exitCode ?? null,
      costUsd: m.costUsd ?? null,
      costUsdEstimated: m.costUsdEstimated ? 1 : 0,
      inputTokens: m.inputTokens ?? null,
      outputTokens: m.outputTokens ?? null,
      cachedInputTokens: m.cachedInputTokens ?? null,
      reasoningOutputTokens: m.reasoningOutputTokens ?? null,
      sessionId: m.sessionId ?? null,
      durationMs: m.durationMs ?? null,
      rateLimitMessage: fields.rateLimitMessage ?? null,
      rateLimitResetAt: fields.rateLimitResetAt ?? null,
      stdoutLogPath: fields.stdoutLogPath ?? null,
      stderrLogPath: fields.stderrLogPath ?? null,
      errorMessage: fields.errorMessage ?? null,
    });
}

export function listRuns(taskId: string): any[] {
  return getDb().prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at').all(taskId);
}

export function insertUsageEvents(events: NewUsageEvent[], taskRunId?: string): number {
  if (events.length === 0) return 0;
  const stmt = getDb().prepare(
    `INSERT INTO usage_events (id, tool, source, occurred_at, session_id, task_run_id,
       cost_usd, cost_usd_estimated, input_tokens, output_tokens, cached_input_tokens,
       rate_limit_hit, rate_limit_reset_at, raw_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertAll = getDb().transaction((evts: NewUsageEvent[]) => {
    for (const e of evts) {
      stmt.run(
        randomUUID(),
        e.tool,
        e.source,
        e.occurredAt,
        e.sessionId,
        taskRunId ?? null,
        e.costUsd,
        e.costUsdEstimated ? 1 : 0,
        e.inputTokens,
        e.outputTokens,
        e.cachedInputTokens,
        e.rateLimitHit ? 1 : 0,
        e.rateLimitResetAt,
        e.rawRef
      );
    }
  });
  insertAll(events);
  return events.length;
}

export interface UsageEventRow {
  id: string;
  tool: ToolName;
  source: string;
  occurred_at: string;
  rate_limit_hit: number;
  rate_limit_reset_at: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  raw_ref: string | null;
}

export function usageEventsSince(tool: ToolName, sinceIso: string): UsageEventRow[] {
  return getDb()
    .prepare('SELECT * FROM usage_events WHERE tool = ? AND occurred_at >= ? ORDER BY occurred_at')
    .all(tool, sinceIso) as UsageEventRow[];
}

export function latestRateLimit(tool: ToolName): UsageEventRow | undefined {
  return getDb()
    .prepare(
      'SELECT * FROM usage_events WHERE tool = ? AND rate_limit_hit = 1 ORDER BY occurred_at DESC LIMIT 1'
    )
    .get(tool) as UsageEventRow | undefined;
}
