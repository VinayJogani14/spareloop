import { randomUUID } from 'crypto';
import { getDb } from './db';
import { PermissionMode, ToolName } from '../adapters/types';

export interface ProfileRow {
  id: string;
  name: string;
  tool: ToolName;
  project_dir: string;
  model: string | null;
  permission_mode: PermissionMode;
  extra_args_json: string | null;
  account: string | null;
  instructions: string | null;
  memory_provider: string | null;
  created_at: string;
  updated_at: string;
}

export function addProfile(p: {
  name: string;
  tool: ToolName;
  projectDir: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  account?: string | null;
  instructions?: string | null;
  memoryProvider?: string | null;
}): ProfileRow {
  getDb()
    .prepare(
      `INSERT INTO profiles (id, name, tool, project_dir, model, permission_mode, account, instructions, memory_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      p.name,
      p.tool,
      p.projectDir,
      p.model ?? null,
      p.permissionMode ?? 'allowlist',
      p.account ?? null,
      p.instructions ?? null,
      p.memoryProvider ?? null
    );
  return getProfile(p.name)!;
}

export function getProfile(name: string): ProfileRow | undefined {
  return getDb().prepare('SELECT * FROM profiles WHERE name = ?').get(name) as
    | ProfileRow
    | undefined;
}

export function listProfiles(): ProfileRow[] {
  return getDb().prepare('SELECT * FROM profiles ORDER BY name').all() as ProfileRow[];
}

export function removeProfile(name: string): void {
  const res = getDb().prepare('DELETE FROM profiles WHERE name = ?').run(name);
  if (res.changes === 0) throw new Error(`no profile named ${name}`);
}
