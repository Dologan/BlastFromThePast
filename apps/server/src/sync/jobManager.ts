import type { SyncProgress } from './lastfmSync.js';

export interface JobStatus {
  running: boolean;
  job: string | null;
  progress: SyncProgress | null;
  error: string | null;
  finishedAt: number | null;
}

/** Serializes background jobs: one sync at a time, status pollable by the UI. */
export class JobManager {
  private status: JobStatus = {
    running: false,
    job: null,
    progress: null,
    error: null,
    finishedAt: null,
  };

  getStatus(): JobStatus {
    return { ...this.status };
  }

  reportProgress = (p: SyncProgress): void => {
    this.status.progress = p;
  };

  /** Returns false if a job is already running. */
  start(name: string, fn: () => Promise<void>): boolean {
    if (this.status.running) return false;
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
      });
    return true;
  }
}
