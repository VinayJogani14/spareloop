import * as fs from 'fs';
import { getDb, kvGet, kvSet } from '../core/db';
import { daemonLogPath } from '../core/paths';
import { allAdapters, getAdapter, rollingWindowAdapters } from '../adapters/registry';
import { getTask, insertUsageEvents, insertTask, listTasks, TaskRow, updateTaskStatus } from '../core/repo';
import { assessCapacity } from '../core/scheduler/capacityPlanner';
import { detectDailyWindow } from '../core/patterns/windowDetector';
import { computePrewarm, getPrewarmConfig, reconcilePrewarmTime, setPrewarmConfig } from '../core/patterns/prewarmComputer';
import { generateSuggestions } from '../core/patterns/suggestionEngine';
import { currentWindowSnapshot, predictWindow } from '../core/patterns/predictor';
import { notify } from '../notify/index';
import { executeTask } from './taskRunner';
import { listAccounts } from '../core/accounts';
import { ToolName } from '../adapters/types';

const PATTERN_RECOMPUTE_INTERVAL_MS = 60 * 60 * 1000; // hourly
const ALERT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 min
const ALERT_THRESHOLDS = [50, 75, 90];

/** Every login a tool has: the default login plus each registered account. */
function loginsFor(tool: ToolName): (string | null)[] {
  return [null, ...listAccounts(tool).map((a) => a.name)];
}

/** In-flight task promises, keyed by tool — max one concurrent task per tool. */
const inFlight = new Map<string, Promise<unknown>>();
/** Task ids currently executing in THIS process (excluded from orphan reaping). */
const inFlightTaskIds = new Set<string>();
/** Project dirs with a task currently executing — never two tasks in one repo. */
const inFlightDirs = new Set<string>();

/** Rotate once the log passes this size, keeping only the most recent lines. */
const LOG_ROTATE_BYTES = 10 * 1024 * 1024; // 10MB
const LOG_KEEP_LINES = 20_000;

function rotateLogIfNeeded(): void {
  try {
    const stat = fs.statSync(daemonLogPath());
    if (stat.size < LOG_ROTATE_BYTES) return;
    const lines = fs.readFileSync(daemonLogPath(), 'utf8').split('\n');
    fs.writeFileSync(daemonLogPath(), lines.slice(-LOG_KEEP_LINES).join('\n'));
  } catch {
    /* no log yet, or unreadable - nothing to rotate */
  }
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    rotateLogIfNeeded();
    fs.appendFileSync(daemonLogPath(), line);
  } catch {
    /* logging must never crash the daemon */
  }
  if (process.stdout.isTTY) process.stdout.write(line);
}

/** One scheduler pass. Runs every tick (persistent daemon) or per cron fire. */
export async function tick(now = new Date()): Promise<void> {
  await ingestInteractiveUsage();
  recoverOrphanedRunning(now);
  recoverRateLimited(now);
  expireOverdue(now);
  maybeRecomputePatterns(now);
  schedulePrewarmTasks(now);
  checkBurnRateAlerts(now);
  await launchEligible(now);
}

/**
 * Threshold alerts (50/75/90% of typical exhaustion budget), deduped per
 * tool per window so a single crossing fires exactly one notification.
 */
function checkBurnRateAlerts(now: Date): void {
  const last = kvGet('last_alert_check');
  if (last && now.getTime() - new Date(last).getTime() < ALERT_CHECK_INTERVAL_MS) return;
  kvSet('last_alert_check', now.toISOString());

  for (const adapter of rollingWindowAdapters()) {
    for (const account of loginsFor(adapter.tool)) {
      const prediction = predictWindow(adapter.tool, now, account);
      if (!prediction.hasData || prediction.percentOfTypicalBudget == null) continue;
      const snapshot = currentWindowSnapshot(adapter.tool, now, account);
      if (!snapshot) continue;

      // Fired-thresholds set is keyed by the actual detected window start, so
      // a new window (new first-prompt or post-reset) naturally gets a fresh
      // set. Scoped per-account since each login's window is independent.
      const acctSuffix = account ? `:${account}` : '';
      const firedKey = `alert_fired:${adapter.tool}${acctSuffix}`;
      const windowMarkerKey = `alert_window_start:${adapter.tool}${acctSuffix}`;
      const windowStartIso = snapshot.windowStartAt.toISOString();
      if (kvGet(windowMarkerKey) !== windowStartIso) {
        kvSet(windowMarkerKey, windowStartIso);
        kvSet(firedKey, '');
      }
      const alreadyFired = new Set((kvGet(firedKey) ?? '').split(',').filter(Boolean));

      for (const threshold of ALERT_THRESHOLDS) {
        const label = String(threshold);
        if (prediction.percentOfTypicalBudget >= threshold && !alreadyFired.has(label)) {
          alreadyFired.add(label);
          const toolLabel = adapter.tool === 'claude' ? 'Claude Code' : 'Codex CLI';
          const who = account ? ` (${account})` : '';
          const msg = `${Math.round(prediction.percentOfTypicalBudget)}% of typical window usage. ${prediction.reason}`;
          notify(`${toolLabel}${who}: ${threshold}% burn-rate alert`, msg);
          log(`burn-rate alert [${adapter.tool}${acctSuffix}] crossed ${threshold}%: ${msg}`);
        }
      }
      kvSet(firedKey, [...alreadyFired].join(','));
    }
  }
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

/**
 * A task stuck in 'running' with no live executor is orphaned (daemon crash,
 * machine died mid-run). Detected two ways:
 *  - its latest run row already ended (crash in the tiny window between
 *    finishRun and the task-status update), or
 *  - its latest run started longer ago than the max run timeout plus grace
 *    and never ended. The threshold stays above the 1h subprocess timeout so
 *    overlapping cron ticks never reap a legitimately-running task.
 */
const ORPHAN_THRESHOLD_MS = 90 * 60 * 1000;

function recoverOrphanedRunning(now: Date): void {
  const rows = getDb()
    .prepare(
      `SELECT t.id AS task_id, t.attempt_count, t.max_attempts,
              r.id AS run_id, r.started_at, r.ended_at
       FROM tasks t
       JOIN task_runs r ON r.id = (
         SELECT id FROM task_runs WHERE task_id = t.id ORDER BY started_at DESC, rowid DESC LIMIT 1
       )
       WHERE t.status = 'running' AND t.id NOT IN (
         SELECT value FROM json_each(?)
       )`
    )
    .all(JSON.stringify([...inFlightTaskIds])) as Array<{
    task_id: string;
    attempt_count: number;
    max_attempts: number;
    run_id: string;
    started_at: string;
    ended_at: string | null;
  }>;

  for (const row of rows) {
    const runEnded = row.ended_at != null;
    // sqlite datetime('now') is UTC in "YYYY-MM-DD HH:MM:SS" form
    const startedMs = Date.parse(row.started_at.replace(' ', 'T') + 'Z');
    const stale = now.getTime() - startedMs > ORPHAN_THRESHOLD_MS;
    if (!runEnded && !stale) continue;

    if (!runEnded) {
      getDb()
        .prepare(
          `UPDATE task_runs SET ended_at = datetime('now'), outcome = 'failure',
             error_message = 'orphaned: daemon or machine died mid-run' WHERE id = ?`
        )
        .run(row.run_id);
    }
    const status = row.attempt_count < row.max_attempts ? 'queued' : 'failed';
    updateTaskStatus(row.task_id, status);
    log(`task ${row.task_id.slice(0, 8)} was orphaned in 'running'; ${status === 'queued' ? 're-queued' : 'marked failed (attempts exhausted)'}`);
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
    for (const account of loginsFor(adapter.tool)) {
      const who = account ? `${adapter.tool}/${account}` : adapter.tool;
      try {
        const pattern = detectDailyWindow(adapter.tool, now, account);
        const decision = computePrewarm(pattern);
        const moved = reconcilePrewarmTime(adapter.tool as 'claude' | 'codex', account, decision);
        if (moved.changed) {
          log(`prewarm time for ${who} converged: ${moved.from ?? 'unset'} -> ${moved.to}`);
        }
        const suggestions = generateSuggestions(pattern);
        for (const s of suggestions) log(`new suggestion [${who}/${s.kind}]`);
      } catch (err) {
        log(`pattern compute error for ${who}: ${(err as Error).message}`);
      }
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
    for (const account of loginsFor(tool)) {
      const cfg = getPrewarmConfig(tool, account);
      if (!cfg || cfg.enabled !== 1 || !cfg.scheduled_local_time) continue;

      const todayKey = now.toISOString().slice(0, 10);
      const markerKey = `prewarm_scheduled:${tool}:${account ?? ''}:${todayKey}`;
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
        account, // fires under the SAME login whose pattern triggered it
        isPrewarm: true,
        scheduleKind: 'explicit',
        scheduleAt: fireAt.toISOString(),
        maxAttempts: 1,
        priority: 100, // prewarm exists to start the window — never let backlog delay it
      });
      kvSet(markerKey, '1');
      setPrewarmConfig(tool, account, {});
      log(`prewarm task scheduled for ${tool}${account ? '/' + account : ''} at ${cfg.scheduled_local_time} (${fireAt.toISOString()})`);
    }
  }
}

/**
 * Chain gating: a task with a dependency runs only after it succeeds, waits
 * while it's pending/running/rate-limited, and is cancelled if it terminally
 * failed (running "fix the tests" after "the migration failed" helps nobody).
 */
export type DepGate = 'run' | 'wait' | 'cancel';
export function dependencyGate(depStatus: TaskRow['status'] | null): DepGate {
  if (depStatus === null || depStatus === 'succeeded') return 'run';
  if (depStatus === 'failed' || depStatus === 'cancelled' || depStatus === 'expired') return 'cancel';
  return 'wait';
}

async function launchEligible(now: Date): Promise<void> {
  const queued = listTasks({ status: 'queued' }).sort(
    (a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at)
  );

  const launchedTools = new Set<string>();
  const launchedDirs = new Set<string>();
  for (const task of queued) {
    if (inFlight.has(task.tool) || launchedTools.has(task.tool)) continue;
    if (inFlightDirs.has(task.project_dir) || launchedDirs.has(task.project_dir)) continue;
    if (task.not_before && new Date(task.not_before) > now) continue;

    if (task.depends_on) {
      const dep = getTask(task.depends_on);
      const gate = dependencyGate(dep ? dep.status : 'failed');
      if (gate === 'cancel') {
        updateTaskStatus(task.id, 'cancelled');
        log(`task ${task.id.slice(0, 8)} cancelled: dependency ${task.depends_on.slice(0, 8)} ${dep?.status ?? 'missing'}`);
        continue;
      }
      if (gate === 'wait') continue;
    }

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
    launchedDirs.add(task.project_dir);
    inFlightTaskIds.add(task.id);
    inFlightDirs.add(task.project_dir);
    const p = executeTask(task, log)
      .catch((err) => log(`executor crashed for task ${task.id.slice(0, 8)}: ${(err as Error).message}`))
      .finally(() => {
        inFlight.delete(task.tool);
        inFlightTaskIds.delete(task.id);
        inFlightDirs.delete(task.project_dir);
      });
    inFlight.set(task.tool, p);
  }
}

export function hasInFlight(): boolean {
  return inFlight.size > 0;
}

export async function drainInFlight(): Promise<void> {
  await Promise.allSettled([...inFlight.values()]);
}
