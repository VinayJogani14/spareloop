import * as fs from 'fs';
import { getDb, kvGet, kvSet } from '../core/db';
import { daemonLogPath } from '../core/paths';
import { allAdapters, getAdapter, rollingWindowAdapters } from '../adapters/registry';
import { insertUsageEvents, insertTask, listTasks, TaskRow, updateTaskStatus } from '../core/repo';
import { assessCapacity } from '../core/scheduler/capacityPlanner';
import { detectDailyWindow } from '../core/patterns/windowDetector';
import { computePrewarm, getPrewarmConfig, reconcilePrewarmTime, setPrewarmConfig } from '../core/patterns/prewarmComputer';
import { generateSuggestions } from '../core/patterns/suggestionEngine';
import { executeTask } from './taskRunner';

const PATTERN_RECOMPUTE_INTERVAL_MS = 60 * 60 * 1000; // hourly

/** In-flight task promises, keyed by tool — max one concurrent task per tool. */
const inFlight = new Map<string, Promise<unknown>>();

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(daemonLogPath(), line);
  } catch {
    /* logging must never crash the daemon */
  }
  if (process.stdout.isTTY) process.stdout.write(line);
}

/** One scheduler pass. Runs every tick (persistent daemon) or per cron fire. */
export async function tick(now = new Date()): Promise<void> {
  await ingestInteractiveUsage();
  recoverRateLimited(now);
  expireOverdue(now);
  maybeRecomputePatterns(now);
  schedulePrewarmTasks(now);
  await launchEligible(now);
}

async function ingestInteractiveUsage(): Promise<void> {
  for (const adapter of allAdapters()) {
    try {
      const cursorKey = `ingest_cursor:${adapter.tool}`;
      const { events, newCursor } = await adapter.ingestInteractiveUsage(kvGet(cursorKey));
      if (events.length > 0) {
        insertUsageEvents(events);
        log(`ingested ${events.length} interactive usage event(s) from ${adapter.tool}`);
      }
      if (newCursor != null) kvSet(cursorKey, newCursor);
    } catch (err) {
      log(`ingest error for ${adapter.tool}: ${(err as Error).message}`);
    }
  }
}

function recoverRateLimited(now: Date): void {
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE status = 'rate_limited' AND (not_before IS NULL OR not_before <= ?)`)
    .all(now.toISOString()) as TaskRow[];
  for (const t of rows) {
    updateTaskStatus(t.id, 'queued');
    log(`task ${t.id.slice(0, 8)} recovered from rate-limit hold; re-queued`);
  }
}

function expireOverdue(now: Date): void {
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE status = 'queued' AND not_after IS NOT NULL AND not_after < ?`)
    .all(now.toISOString()) as TaskRow[];
  for (const t of rows) {
    updateTaskStatus(t.id, 'expired');
    log(`task ${t.id.slice(0, 8)} expired (deadline ${t.not_after})`);
  }
}

function maybeRecomputePatterns(now: Date): void {
  const last = kvGet('last_pattern_compute');
  if (last && now.getTime() - new Date(last).getTime() < PATTERN_RECOMPUTE_INTERVAL_MS) return;
  kvSet('last_pattern_compute', now.toISOString());

  for (const adapter of rollingWindowAdapters()) {
    try {
      const pattern = detectDailyWindow(adapter.tool, now);
      const decision = computePrewarm(pattern);
      const moved = reconcilePrewarmTime(adapter.tool as 'claude' | 'codex', decision);
      if (moved.changed) {
        log(`prewarm time for ${adapter.tool} converged: ${moved.from ?? 'unset'} -> ${moved.to}`);
      }
      const suggestions = generateSuggestions(pattern);
      for (const s of suggestions) log(`new suggestion [${s.tool}/${s.kind}]`);
    } catch (err) {
      log(`pattern compute error for ${adapter.tool}: ${(err as Error).message}`);
    }
  }
}

/**
 * Once per day per enabled rolling-window tool, insert the synthetic prewarm
 * task at the converged local fire time.
 */
function schedulePrewarmTasks(now: Date): void {
  for (const adapter of rollingWindowAdapters()) {
    const tool = adapter.tool as 'claude' | 'codex';
    const cfg = getPrewarmConfig(tool);
    if (!cfg || cfg.enabled !== 1 || !cfg.scheduled_local_time) continue;

    const todayKey = now.toISOString().slice(0, 10);
    const markerKey = `prewarm_scheduled:${tool}:${todayKey}`;
    if (kvGet(markerKey)) continue;

    const [h, m] = cfg.scheduled_local_time.split(':').map(Number);
    const fireAt = new Date(now);
    fireAt.setHours(h, m, 0, 0);
    if (fireAt <= now) continue; // today's slot already passed; schedule resumes tomorrow

    insertTask({
      prompt: 'Reply with exactly: OK',
      tool,
      projectDir: process.env.HOME ?? '/tmp',
      permissionMode: 'allowlist',
      isPrewarm: true,
      scheduleKind: 'explicit',
      scheduleAt: fireAt.toISOString(),
      maxAttempts: 1,
      priority: 100, // prewarm exists to start the window — never let backlog delay it
    });
    kvSet(markerKey, '1');
    setPrewarmConfig(tool, {});
    log(`prewarm task scheduled for ${tool} at ${cfg.scheduled_local_time} (${fireAt.toISOString()})`);
  }
}

async function launchEligible(now: Date): Promise<void> {
  const queued = listTasks({ status: 'queued' }).sort(
    (a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at)
  );

  const launchedTools = new Set<string>();
  for (const task of queued) {
    if (inFlight.has(task.tool) || launchedTools.has(task.tool)) continue;
    if (task.not_before && new Date(task.not_before) > now) continue;

    let eligible = false;
    if (task.schedule_kind === 'explicit') {
      eligible = task.schedule_at != null && new Date(task.schedule_at) <= now;
    } else {
      // asap + spare_capacity both defer to the live capacity planner; the
      // learned dead-zone informs suggestions and add-time defaults, while the
      // planner stays the runtime authority (more responsive to real signals).
      const verdict = assessCapacity(getAdapter(task.tool), now);
      eligible = verdict.capacity === 'available';
      if (!eligible && verdict.capacity === 'likely_dead_zone' && task.is_prewarm === 0) {
        // Counterintuitive but correct: OUR queued run also can't get through
        // the tool's own rate limit during a true dead zone; the reactive
        // rate-limit handler will catch it if the heuristic is wrong.
        eligible = true;
      }
    }
    if (!eligible) continue;

    launchedTools.add(task.tool);
    const p = executeTask(task, log)
      .catch((err) => log(`executor crashed for task ${task.id.slice(0, 8)}: ${(err as Error).message}`))
      .finally(() => inFlight.delete(task.tool));
    inFlight.set(task.tool, p);
  }
}

export function hasInFlight(): boolean {
  return inFlight.size > 0;
}

export async function drainInFlight(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}
