import { ToolName } from '../adapters/types';
import { predictWindow } from './patterns/predictor';
import { listTasks } from './repo';

const BAR_SEGMENTS = 10;

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_SEGMENTS, Math.round((percent / 100) * BAR_SEGMENTS)));
  return '▮'.repeat(filled) + '▯'.repeat(BAR_SEGMENTS - filled);
}

/**
 * Compact single-line summary for embedding in Claude Code's statusLine,
 * tmux, or a shell prompt (starship `custom` module, etc).
 */
export function renderOneLine(tool: ToolName, now = new Date()): string {
  const prediction = predictWindow(tool, now);
  const queued = listTasks({ status: 'queued', tool }).length;
  const rateLimited = listTasks({ status: 'rate_limited', tool }).length;

  const parts: string[] = [];
  if (prediction.hasData && prediction.percentOfTypicalBudget != null) {
    const pct = Math.min(100, Math.round(prediction.percentOfTypicalBudget));
    parts.push(`${bar(pct)} ${pct}%`);
    if (prediction.etaAt) {
      const eta = new Date(prediction.etaAt);
      parts.push(`~wall ${eta.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    }
  } else {
    parts.push('no usage data yet');
  }
  if (queued > 0) parts.push(`${queued} queued`);
  if (rateLimited > 0) parts.push(`${rateLimited} rate-limited`);

  return `spareloop[${tool}] ${parts.join(' · ')}`;
}
