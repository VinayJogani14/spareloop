import { getDb } from './db';

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

export interface ExportFilter {
  tool?: string;
  days?: number;
}

export function exportUsageEvents(filter: ExportFilter): Record<string, unknown>[] {
  const since = new Date(Date.now() - (filter.days ?? 30) * 24 * 3600 * 1000).toISOString();
  let sql = `SELECT tool, account, source, occurred_at, session_id, cost_usd, cost_usd_estimated,
                    input_tokens, output_tokens, cached_input_tokens, rate_limit_hit, rate_limit_reset_at
             FROM usage_events WHERE occurred_at >= ?`;
  const params: unknown[] = [since];
  if (filter.tool) {
    sql += ' AND tool = ?';
    params.push(filter.tool);
  }
  sql += ' ORDER BY occurred_at';
  return getDb().prepare(sql).all(...params) as Record<string, unknown>[];
}

export function exportTaskRuns(filter: ExportFilter): Record<string, unknown>[] {
  const since = new Date(Date.now() - (filter.days ?? 30) * 24 * 3600 * 1000).toISOString();
  let sql = `SELECT r.started_at, r.ended_at, r.tool, r.account, r.outcome, r.cost_usd,
                    r.cost_usd_estimated, r.duration_ms, r.git_branch, t.prompt, t.project_dir,
                    t.schedule_kind, t.is_prewarm
             FROM task_runs r JOIN tasks t ON t.id = r.task_id
             WHERE r.started_at >= ?`;
  const params: unknown[] = [since];
  if (filter.tool) {
    sql += ' AND r.tool = ?';
    params.push(filter.tool);
  }
  sql += ' ORDER BY r.started_at';
  return getDb().prepare(sql).all(...params) as Record<string, unknown>[];
}
