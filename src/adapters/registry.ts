import { CliAdapter, isRollingWindowAdapter, RollingWindowAdapter, ToolName } from './types';
import { ClaudeAdapter } from './claude';
import { CodexAdapter } from './codex';
import { CursorAdapter } from './cursor';

const adapters: Record<ToolName, CliAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  cursor: new CursorAdapter(),
};

export function getAdapter(tool: ToolName): CliAdapter {
  return adapters[tool];
}

export function allAdapters(): CliAdapter[] {
  return Object.values(adapters);
}

export function rollingWindowAdapters(): RollingWindowAdapter[] {
  return allAdapters().filter(isRollingWindowAdapter);
}

export function isToolName(s: string): s is ToolName {
  return s === 'claude' || s === 'codex' || s === 'cursor';
}
