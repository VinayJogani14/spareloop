import Database from 'better-sqlite3';
import { dbPath, ensureDirs } from './paths';

const MIGRATION_V2 = `
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  tool        TEXT NOT NULL CHECK (tool IN ('claude','codex')),
  config_dir  TEXT NOT NULL,
  route_order INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE tasks ADD COLUMN account TEXT;
ALTER TABLE tasks ADD COLUMN depends_on TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN same_session INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN instructions TEXT;
ALTER TABLE tasks ADD COLUMN resume_session_id TEXT;
ALTER TABLE tasks ADD COLUMN branch_mode TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE task_runs ADD COLUMN account TEXT;
ALTER TABLE task_runs ADD COLUMN git_branch TEXT;
ALTER TABLE task_runs ADD COLUMN worktree_path TEXT;

ALTER TABLE usage_events ADD COLUMN account TEXT;

ALTER TABLE profiles ADD COLUMN account TEXT;
ALTER TABLE profiles ADD COLUMN instructions TEXT;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  tool          TEXT NOT NULL CHECK (tool IN ('claude','codex','cursor')),
  project_dir   TEXT NOT NULL,
  model         TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'allowlist'
                CHECK (permission_mode IN ('allowlist','full_bypass')),
  extra_args_json TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  prompt          TEXT NOT NULL,
  tool            TEXT NOT NULL CHECK (tool IN ('claude','codex','cursor')),
  project_dir     TEXT NOT NULL,
  model           TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'allowlist'
                  CHECK (permission_mode IN ('allowlist','full_bypass')),
  extra_args_json TEXT,
  profile_id      TEXT REFERENCES profiles(id),
  is_prewarm      INTEGER NOT NULL DEFAULT 0,

  schedule_kind   TEXT NOT NULL CHECK (schedule_kind IN ('explicit','spare_capacity','asap')),
  schedule_at     TEXT,
  not_before      TEXT,
  not_after       TEXT,

  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','failed','rate_limited','expired','cancelled')),
  priority        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  budget_usd_cap  REAL,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, schedule_kind, schedule_at);

CREATE TABLE IF NOT EXISTS task_runs (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  attempt_number  INTEGER NOT NULL,
  tool            TEXT NOT NULL,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  exit_code       INTEGER,
  outcome         TEXT CHECK (outcome IN ('success','failure','rate_limited','timeout','cancelled')),

  cost_usd        REAL,
  cost_usd_estimated INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cached_input_tokens INTEGER,
  reasoning_output_tokens INTEGER,

  session_id      TEXT,
  duration_ms     INTEGER,
  rate_limit_message TEXT,
  rate_limit_reset_at TEXT,
  stdout_log_path TEXT,
  stderr_log_path TEXT,
  error_message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT PRIMARY KEY,
  tool            TEXT NOT NULL CHECK (tool IN ('claude','codex','cursor')),
  source          TEXT NOT NULL CHECK (source IN ('interactive','queued_task','prewarm')),
  occurred_at     TEXT NOT NULL,
  session_id      TEXT,
  task_run_id     TEXT REFERENCES task_runs(id),

  cost_usd        REAL,
  cost_usd_estimated INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cached_input_tokens INTEGER,

  rate_limit_hit  INTEGER NOT NULL DEFAULT 0,
  rate_limit_reset_at TEXT,
  raw_ref         TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_events_tool_time ON usage_events(tool, occurred_at);

CREATE TABLE IF NOT EXISTS learned_patterns (
  id              TEXT PRIMARY KEY,
  tool            TEXT NOT NULL,
  pattern_type    TEXT NOT NULL CHECK (pattern_type IN ('daily_window','dead_zone')),
  computed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  window_start_local TEXT,
  window_exhaustion_local TEXT,
  window_reset_local TEXT,
  dead_zone_minutes  INTEGER,
  confidence      REAL NOT NULL,
  sample_days     INTEGER NOT NULL,
  lookback_days   INTEGER NOT NULL DEFAULT 21,
  details_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_patterns ON learned_patterns(tool, pattern_type, computed_at);

CREATE TABLE IF NOT EXISTS suggestions (
  id              TEXT PRIMARY KEY,
  pattern_id      TEXT REFERENCES learned_patterns(id),
  kind            TEXT NOT NULL CHECK (kind IN ('queue_into_dead_zone','enable_prewarm','adjust_prewarm_time','none_stable')),
  tool            TEXT NOT NULL,
  message         TEXT NOT NULL,
  proposed_prewarm_local TEXT,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','shown','accepted','dismissed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prewarm_config (
  tool            TEXT PRIMARY KEY CHECK (tool IN ('claude','codex')),
  enabled         INTEGER NOT NULL DEFAULT 0,
  scheduled_local_time TEXT,
  manual_override INTEGER NOT NULL DEFAULT 0,
  last_fired_at   TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kv_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

const MIGRATION_V3 = `
CREATE TABLE suggestions_new (
  id              TEXT PRIMARY KEY,
  pattern_id      TEXT REFERENCES learned_patterns(id),
  kind            TEXT NOT NULL,
  tool            TEXT NOT NULL,
  message         TEXT NOT NULL,
  proposed_prewarm_local TEXT,
  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','shown','accepted','dismissed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO suggestions_new SELECT * FROM suggestions;
DROP TABLE suggestions;
ALTER TABLE suggestions_new RENAME TO suggestions;
`;

const MIGRATION_V4 = `
ALTER TABLE learned_patterns ADD COLUMN account TEXT;
ALTER TABLE suggestions ADD COLUMN account TEXT;

-- prewarm_config becomes keyed by (tool, account): each registered account
-- has its own rolling window and rhythm, so prewarm must be computed and
-- fired per-account, not once per tool. account = '' is the sentinel for
-- the default (non-spareloop-managed) login, since NULL can't be used as
-- part of a meaningful uniqueness constraint (SQL NULL != NULL).
CREATE TABLE prewarm_config_new (
  tool            TEXT NOT NULL CHECK (tool IN ('claude','codex')),
  account         TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 0,
  scheduled_local_time TEXT,
  manual_override INTEGER NOT NULL DEFAULT 0,
  last_fired_at   TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tool, account)
);
INSERT INTO prewarm_config_new (tool, account, enabled, scheduled_local_time, manual_override, last_fired_at, updated_at)
  SELECT tool, '', enabled, scheduled_local_time, manual_override, last_fired_at, updated_at FROM prewarm_config;
DROP TABLE prewarm_config;
ALTER TABLE prewarm_config_new RENAME TO prewarm_config;
`;

const MIGRATION_V5 = `
ALTER TABLE profiles ADD COLUMN memory_provider TEXT;
`;

/** Ordered migrations; index i applies when user_version < i+1. */
const MIGRATIONS: string[] = [SCHEMA, MIGRATION_V2, MIGRATION_V3, MIGRATION_V4, MIGRATION_V5];

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  ensureDirs();
  _db = new Database(dbPath());
  _db.pragma('journal_mode = WAL');
  let version = _db.pragma('user_version', { simple: true }) as number;
  while (version < MIGRATIONS.length) {
    _db.exec(MIGRATIONS[version]);
    version += 1;
    _db.pragma(`user_version = ${version}`);
  }
  return _db;
}

export function kvGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM kv_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function kvSet(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
