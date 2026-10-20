import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireJobLock, currentJobLock } from '../src/sync/jobLock.js';
import { JobManager } from '../src/sync/jobManager.js';

/** A pid that belonged to a process which has already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!;
}

describe('job lock', () => {
  let dir: string;
  const lockFile = () => path.join(dir, 'job.lock');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bftp-lock-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is exclusive while held and free again after release', () => {
    const release = acquireJobLock(dir, 'lastfm', 'cli');
    expect(release).not.toBeNull();
    expect(currentJobLock(dir)).toMatchObject({ job: 'lastfm', source: 'cli', pid: process.pid });

    // Our own pid is alive, so a second taker is refused.
    expect(acquireJobLock(dir, 'enrich', 'server')).toBeNull();

    release!();
    expect(currentJobLock(dir)).toBeNull();
    expect(acquireJobLock(dir, 'enrich', 'server')).not.toBeNull();
  });

  it('clears a stale lock left by a process that exited', () => {
    fs.writeFileSync(lockFile(), JSON.stringify({ job: 'lastfm', source: 'cli', pid: deadPid(), startedAt: 1 }));
    expect(currentJobLock(dir)).toBeNull();
    expect(fs.existsSync(lockFile())).toBe(false);

    fs.writeFileSync(lockFile(), JSON.stringify({ job: 'lastfm', source: 'cli', pid: deadPid(), startedAt: 1 }));
    const release = acquireJobLock(dir, 'enrich', 'server');
    expect(release).not.toBeNull();
    expect(currentJobLock(dir)?.job).toBe('enrich');
    release!();
  });

  it('treats an unreadable lock file as stale', () => {
    fs.writeFileSync(lockFile(), '{"job": "lastf');
    expect(currentJobLock(dir)).toBeNull();
    expect(acquireJobLock(dir, 'enrich', 'server')).not.toBeNull();
  });

  it('does not release a lock that now belongs to someone else', () => {
    const release = acquireJobLock(dir, 'lastfm', 'cli')!;
    // Simulate the lock having been taken over after ours was cleared.
    fs.writeFileSync(lockFile(), JSON.stringify({ job: 'other', source: 'cli', pid: process.pid, startedAt: 999 }));
    release();
    expect(currentJobLock(dir)?.job).toBe('other');
  });
});

describe('JobManager with a job lock', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bftp-lock-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to start while a cron job holds the lock, and takes the lock while running', async () => {
    fs.writeFileSync(
      path.join(dir, 'job.lock'),
      JSON.stringify({ job: 'lastfm', source: 'cli', pid: process.pid, startedAt: Date.now() }),
    );
    const jobs = new JobManager(dir);
    let ran = false;
    expect(jobs.start('enrich', async () => { ran = true; })).toBe(false);
    expect(ran).toBe(false);
    expect(jobs.getStatus().running).toBe(false);

    fs.rmSync(path.join(dir, 'job.lock'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    expect(jobs.start('enrich', () => gate)).toBe(true);
    expect(currentJobLock(dir)).toMatchObject({ job: 'enrich', source: 'server' });

    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(jobs.getStatus().running).toBe(false);
    expect(currentJobLock(dir)).toBeNull();
  });
});
