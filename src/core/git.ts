import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { dataDir } from './paths';

export interface CommitResult {
  committed: boolean;
  fileCount: number;
}

/** Above this many changed files, flag the commit as worth a second look -
 *  likely an accidentally-swept build artifact (node_modules, dist, etc)
 *  rather than intentional agent output. */
const LARGE_COMMIT_FILE_THRESHOLD = 200;

/**
 * Commit whatever the agent changed in a worktree onto its branch. Without
 * this, changes sit as uncommitted working-tree files: `git diff`/`git log`
 * against the branch would show nothing (the review workflow would be
 * hollow), and deleting or cleaning up the worktree would silently lose the
 * work. Commits on every outcome (not just success) so a failed/retried
 * attempt's partial work is never lost either. No-ops cleanly if the agent
 * made no changes.
 *
 * Uses `git add -A`, which respects the target repo's own .gitignore but
 * nothing beyond that - if the repo doesn't ignore build artifacts (e.g. a
 * task runs `npm install` in a repo with no node_modules entry) they get
 * committed onto the review branch. Caller gets fileCount back to decide
 * whether to warn.
 */
export function commitWorktreeChanges(worktreePath: string, message: string): CommitResult {
  try {
    const status = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    const lines = status.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return { committed: false, fileCount: 0 };
    execFileSync('git', ['-C', worktreePath, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', worktreePath, 'commit', '-m', message, '--no-verify'], {
      stdio: 'ignore',
    });
    return { committed: true, fileCount: lines.length };
  } catch {
    return { committed: false, fileCount: 0 };
  }
}

export function isLargeCommit(fileCount: number): boolean {
  return fileCount > LARGE_COMMIT_FILE_THRESHOLD;
}

/** Compact `git diff --stat` summary between a repo's HEAD and one of its branches. */
export function diffStat(repoDir: string, branch: string): string | null {
  try {
    const out = execFileSync('git', ['-C', repoDir, 'diff', '--stat', `HEAD...${branch}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Remove a worktree's checked-out directory. Does NOT delete the branch or
 * its commits - `git worktree remove` only detaches the working copy, so the
 * user can still `git checkout <branch>` afterward if they change their mind.
 */
export function removeWorktree(worktreePath: string, repoDir: string): boolean {
  try {
    execFileSync('git', ['-C', repoDir, 'worktree', 'remove', worktreePath, '--force'], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    // Repo may have moved/been deleted, or the worktree may already be gone -
    // fall back to a plain directory removal so cleanup still makes progress.
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export interface Workspace {
  /** Directory the task should actually run in. */
  runDir: string;
  gitBranch: string | null;
  worktreePath: string | null;
}

/**
 * Trust boundary for unattended runs: never let an agent edit the user's
 * working tree. For git repos (unless the task opted out) the task runs in a
 * dedicated git worktree on branch `spareloop/<short-id>`, created from the
 * repo's current HEAD. The user reviews and merges on their own schedule; the
 * worktree persists until `spareloop clean` (or manual `git worktree remove`).
 *
 * Retries reuse the existing worktree so a rate-limited task resumes its own
 * partial work rather than starting over.
 */
export function prepareWorkspace(
  taskId: string,
  projectDir: string,
  branchMode: 'auto' | 'none',
  log: (msg: string) => void
): Workspace {
  if (branchMode === 'none' || !isGitRepo(projectDir)) {
    return { runDir: projectDir, gitBranch: null, worktreePath: null };
  }

  const shortId = taskId.slice(0, 8);
  const branch = `spareloop/${shortId}`;
  const worktreePath = path.join(dataDir(), 'worktrees', shortId);

  if (fs.existsSync(path.join(worktreePath, '.git'))) {
    return { runDir: worktreePath, gitBranch: branch, worktreePath };
  }

  try {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    execFileSync('git', ['-C', projectDir, 'worktree', 'add', worktreePath, '-b', branch], {
      stdio: 'ignore',
    });
    return { runDir: worktreePath, gitBranch: branch, worktreePath };
  } catch (err) {
    // Never block the task on worktree failure (e.g. branch left over from a
    // deleted task): fall back to running in place, loudly.
    log(
      `worktree creation failed for ${shortId} (${(err as Error).message.slice(0, 120)}); ` +
        `running in place in ${projectDir}`
    );
    return { runDir: projectDir, gitBranch: null, worktreePath: null };
  }
}
