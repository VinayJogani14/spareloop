import { randomUUID } from 'crypto';
import { getDb } from '../db';
import { WindowPattern } from './windowDetector';
import { computePrewarm, getPrewarmConfig } from './prewarmComputer';
import { listTasks } from '../repo';

export interface Suggestion {
  kind: 'queue_into_dead_zone' | 'enable_prewarm' | 'adjust_prewarm_time' | 'none_stable';
  tool: string;
  message: string;
  proposedPrewarmLocal: string | null;
}

/**
 * Turn a learned pattern into concrete, actionable suggestions.
 * New suggestions are persisted (deduped against recent identical ones) so
 * `spareloop suggest` shows history and the daemon can notify only on change.
 */
export function generateSuggestions(pattern: WindowPattern): Suggestion[] {
  const out: Suggestion[] = [];
  const decision = computePrewarm(pattern);
  const tool = pattern.tool as 'claude' | 'codex';
  const cfg = getPrewarmConfig(tool);

  if (decision.worthEnabling && decision.proposedLocalTime) {
    if (!cfg || cfg.enabled !== 1) {
      out.push({
        kind: 'enable_prewarm',
        tool,
        message:
          `${decision.reason}\n     -> spareloop prewarm enable --tool ${tool}`,
        proposedPrewarmLocal: decision.proposedLocalTime,
      });
    } else if (
      cfg.scheduled_local_time &&
      cfg.scheduled_local_time !== decision.proposedLocalTime &&
      cfg.manual_override !== 1
    ) {
      out.push({
        kind: 'adjust_prewarm_time',
        tool,
        message: `Your pattern drifted: prewarm moving ${cfg.scheduled_local_time} -> ${decision.proposedLocalTime}. ${decision.reason}`,
        proposedPrewarmLocal: decision.proposedLocalTime,
      });
    }
  }

  if (pattern.deadZoneMinutes != null && pattern.deadZoneMinutes >= 20 && pattern.confidence >= 0.4) {
    const spareTasks = listTasks({ status: 'queued', tool: pattern.tool }).filter(
      (t) => t.schedule_kind === 'spare_capacity' || t.schedule_kind === 'asap'
    );
    out.push({
      kind: 'queue_into_dead_zone',
      tool: pattern.tool,
      message:
        `Your ${pattern.windowExhaustionLocal}-${pattern.windowResetLocal} dead zone (~${pattern.deadZoneMinutes} min/day) ` +
        `is prime time for queued background work` +
        (spareTasks.length > 0
          ? ` — ${spareTasks.length} queued task(s) will drain into it automatically.`
          : `. Queue backlog tasks with: spareloop add --spare-capacity`),
      proposedPrewarmLocal: null,
    });
  }

  persistNew(pattern.id, out);
  return out;
}

function persistNew(patternId: string, suggestions: Suggestion[]): void {
  const db = getDb();
  for (const s of suggestions) {
    // Dedupe: skip if an identical-kind suggestion with the same proposed time
    // for this tool already exists in the last 24h.
    const dupe = db
      .prepare(
        `SELECT id FROM suggestions WHERE tool = ? AND kind = ?
           AND COALESCE(proposed_prewarm_local,'') = COALESCE(?, '')
           AND created_at > datetime('now', '-1 day') LIMIT 1`
      )
      .get(s.tool, s.kind, s.proposedPrewarmLocal);
    if (dupe) continue;
    db.prepare(
      `INSERT INTO suggestions (id, pattern_id, kind, tool, message, proposed_prewarm_local)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), patternId, s.kind, s.tool, s.message, s.proposedPrewarmLocal);
  }
}
