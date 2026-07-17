import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getDb } from './db';
import { dataDir } from './paths';
import { ToolName } from '../adapters/types';

export interface AccountRow {
  id: string;
  name: string;
  tool: 'claude' | 'codex';
  config_dir: string;
  route_order: number;
  created_at: string;
}

/**
 * Multiple accounts work because auth is resolved from a config directory,
 * not from the project directory: Claude Code honors CLAUDE_CONFIG_DIR and
 * Codex honors CODEX_HOME. Each spareloop account gets its own isolated
 * config dir, so any account can run a task in any repo.
 *
 * Cursor's CLI has no verified config-dir override, so multi-account is
 * limited to claude/codex for now (enforced by the accounts table CHECK).
 *
 * This exists for people with legitimately separate subscriptions (work +
 * personal). It does not change any vendor-side limit accounting.
 */
export function accountsDir(): string {
  return path.join(dataDir(), 'accounts');
}

export function addAccount(name: string, tool: 'claude' | 'codex'): AccountRow {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('account name must be alphanumeric with dashes/underscores');
  }
  const configDir = path.join(accountsDir(), `${tool}-${name}`);
  fs.mkdirSync(configDir, { recursive: true });
  const id = randomUUID();
  const maxOrder = (getDb()
    .prepare('SELECT COALESCE(MAX(route_order), -1) AS m FROM accounts WHERE tool = ?')
    .get(tool) as { m: number }).m;
  getDb()
    .prepare('INSERT INTO accounts (id, name, tool, config_dir, route_order) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, tool, configDir, maxOrder + 1);
  return getAccount(name)!;
}

export function getAccount(name: string): AccountRow | undefined {
  return getDb().prepare('SELECT * FROM accounts WHERE name = ?').get(name) as
    | AccountRow
    | undefined;
}

export function listAccounts(tool?: ToolName): AccountRow[] {
  return (
    tool
      ? getDb().prepare('SELECT * FROM accounts WHERE tool = ? ORDER BY route_order').all(tool)
      : getDb().prepare('SELECT * FROM accounts ORDER BY tool, route_order').all()
  ) as AccountRow[];
}

export function removeAccount(name: string): void {
  const acct = getAccount(name);
  if (!acct) throw new Error(`no account named ${name}`);
  getDb().prepare('DELETE FROM accounts WHERE name = ?').run(name);
  // Config dir (containing credentials) is intentionally left on disk;
  // deleting credentials should be an explicit human action.
}

/** Environment overrides that point a CLI invocation at this account's auth. */
export function envForAccount(acct: AccountRow): Record<string, string> {
  switch (acct.tool) {
    case 'claude':
      return { CLAUDE_CONFIG_DIR: acct.config_dir };
    case 'codex':
      return { CODEX_HOME: acct.config_dir };
  }
}

/** The interactive login command for each tool, run with the account's env. */
export function loginCommand(acct: AccountRow): { bin: string; args: string[] } {
  switch (acct.tool) {
    case 'claude':
      return { bin: 'claude', args: ['auth', 'login'] };
    case 'codex':
      return { bin: 'codex', args: ['login'] };
  }
}
