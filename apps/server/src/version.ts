import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this module's own location (not process.cwd(), which npm's
// `--workspace` runner points at apps/server, not the repo root) so this
// works the same in dev, tests, and the systemd-deployed `npm start`.
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface VersionInfo {
  /** package.json version at the repo root (bump manually for now). */
  version: string;
  /** Short git commit hash the running process was built from, or null if unavailable
   * (no .git present, e.g. a tarball deploy, or git isn't on PATH). */
  commit: string | null;
  /** ISO timestamp of that commit, or null alongside a null commit. */
  commitDate: string | null;
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Computed once at process startup, not per-request -- the running process's
 * git state can't change while it's up (a deploy always restarts it), so
 * there's no reason to re-shell-out on every /api/version hit. This is also
 * the simplest way to catch a stale deployment: the footer showing an older
 * commit than what's on GitHub means the server hasn't been rebuilt/restarted
 * since the last `git pull` (see deploy/DEPLOY.md's redeploy steps).
 */
export const VERSION: VersionInfo = {
  version: readPackageVersion(),
  commit: git(['rev-parse', '--short', 'HEAD']),
  commitDate: git(['log', '-1', '--format=%cI']),
};
