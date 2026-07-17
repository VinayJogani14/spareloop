import * as fs from 'fs';
import { rollingWindowAdapters, allAdapters } from '../adapters/registry';
import { predictWindow } from './patterns/predictor';
import { listTasks } from './repo';
import { readDaemonPid } from '../daemon/index';
import { daemonLogPath } from './paths';

const BAR_SEGMENTS = 20;

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_SEGMENTS, Math.round((percent / 100) * BAR_SEGMENTS)));
  return '█'.repeat(filled) + '░'.repeat(BAR_SEGMENTS - filled);
}

function tailLines(filePath: string, n: number): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').slice(-n);
  } catch {
    return [];
  }
}

/**
 * Pure render function (no I/O side effects beyond reading current state) so
 * the dashboard layout is unit-testable without a live TTY loop. The CLI
 * `watch` command calls this on an interval and repaints the terminal.
 */
export function renderDashboard(now = new Date()): string {
  const lines: string[] = [];
  lines.push(`spareloop watch — ${now.toLocaleString()}  (Ctrl+C to exit)`);
  lines.push('─'.repeat(70));

  const pid = readDaemonPid();
  lines.push(pid ? `daemon: running (pid ${pid})` : `daemon: NOT RUNNING — spareloop daemon install`);
  lines.push('');

  for (const adapter of rollingWindowAdapters()) {
    const label = adapter.tool === 'claude' ? 'Claude Code' : 'Codex CLI';
    const p = predictWindow(adapter.tool, now);
    if (!p.hasData || p.percentOfTypicalBudget == null) {
      lines.push(`${label.padEnd(12)} ${bar(0)} no usage yet this window`);
      continue;
    }
    const pct = Math.min(100, Math.round(p.percentOfTypicalBudget));
    const eta = p.etaAt ? new Date(p.etaAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    lines.push(`${label.padEnd(12)} ${bar(pct)} ${String(pct).padStart(3)}%  wall~${eta}`);
  }
  for (const adapter of allAdapters()) {
    if (adapter.capabilities.hasRollingWindow) continue;
    lines.push(`${'Cursor'.padEnd(12)} ${bar(0)} monthly credit pool (no window)`);
  }
  lines.push('');

  const queued = listTasks({ status: 'queued' });
  const running = listTasks({ status: 'running' });
  const rateLimited = listTasks({ status: 'rate_limited' });
  lines.push(`queue: ${queued.length} queued · ${running.length} running · ${rateLimited.length} rate-limited`);
  for (const t of running) {
    lines.push(`  ▶ ${t.id.slice(0, 8)} ${t.tool}${t.account ? `@${t.account}` : ''} — ${t.prompt.slice(0, 50)}`);
  }
  lines.push('');

  lines.push('recent activity:');
  const logLines = tailLines(daemonLogPath(), 8);
  if (logLines.length === 0) {
    lines.push('  (no daemon log yet)');
  } else {
    for (const l of logLines) lines.push(`  ${l.slice(0, 100)}`);
  }

  return lines.join('\n');
}
