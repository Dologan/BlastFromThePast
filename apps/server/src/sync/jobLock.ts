import fs from 'node:fs';
import path from 'node:path';

/**
 * A cross-process lock on background jobs. The server and the host CLI (cron)
 * are separate processes sharing one SQLite database, so each takes this lock
 * before running a job and the other side refuses to start while it is held.
 * The lock lives next to the database and records the holder's pid, so a lock
 * left behind by a crashed process is detected and cleared.
 */

const LOCK_FILE = 'job.lock';

export interface JobLock {
  job: string;
  source: 'cli' | 'server';
  pid: number;
  startedAt: number;
}

function lockPath(dataDir: string): string {
  return path.join(dataDir, LOCK_FILE);
}

function parseLock(raw: string): JobLock | null {
  try {
    const parsed = JSON.parse(raw) as Partial<JobLock>;
    if (typeof parsed.pid !== 'number' || typeof parsed.job !== 'string') return null;
    return parsed as JobLock;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock currently held by a live process, or null. Stale or unreadable locks are removed. */
export function currentJobLock(dataDir: string): JobLock | null {
  const file = lockPath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lock = parseLock(raw);
  if (lock && isAlive(lock.pid)) return lock;
  fs.rmSync(file, { force: true });
  return null;
}

/**
 * Takes the lock for `job`. Returns a release function, or null if another live
 * process already holds it.
 */
export function acquireJobLock(
  dataDir: string,
  job: string,
  source: JobLock['source'],
): (() => void) | null {
  const file = lockPath(dataDir);
  const lock: JobLock = { job, source, pid: process.pid, startedAt: Date.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx' fails if the file exists, so two processes can't both take the lock.
      fs.writeFileSync(file, JSON.stringify(lock), { flag: 'wx' });
      return () => {
        const held = currentHolder(file);
        if (held?.pid === lock.pid && held.startedAt === lock.startedAt) fs.rmSync(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Held by a live process: refuse. Otherwise the stale file was cleared, so retry once.
      if (currentJobLock(dataDir)) return null;
    }
  }
  return null;
}

function currentHolder(file: string): JobLock | null {
  try {
    return parseLock(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
