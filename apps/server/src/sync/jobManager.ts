import { acquireJobLock } from './jobLock.js';

export interface JobStatus {
  running: boolean;
  job: string | null;
  /** Job-specific progress payload; the UI interprets it based on `job`. */
  progress: unknown;
  error: string | null;
  finishedAt: number | null;
}

/**
 * Serializes background jobs: one sync at a time, status pollable by the UI.
 * With `lockDir`, each job also takes the cross-process job lock so a host cron
 * job and a UI-started job can't run at the same time.
 */
export class JobManager {
  private status: JobStatus = {
    running: false,
    job: null,
    progress: null,
    error: null,
    finishedAt: null,
  };

  constructor(private readonly lockDir?: string) {}

  getStatus(): JobStatus {
    return { ...this.status };
  }

  reportProgress = (p: unknown): void => {
    this.status.progress = p;
  };

  /** Returns false if a job is already running, in this process or on the host (cron). */
  start(name: string, fn: () => Promise<void>): boolean {
    if (this.status.running) return false;
    const release = this.lockDir ? acquireJobLock(this.lockDir, name, 'server') : () => {};
    if (!release) return false;
    this.status = { running: true, job: name, progress: null, error: null, finishedAt: null };
    void fn()
      .then(() => {
        this.status = { ...this.status, running: false, finishedAt: Date.now() };
      })
      .catch((err) => {
        this.status = {
          ...this.status,
          running: false,
          error: err instanceof Error ? err.message : String(err),
          finishedAt: Date.now(),
        };
      })
      .finally(release);
    return true;
  }
}
