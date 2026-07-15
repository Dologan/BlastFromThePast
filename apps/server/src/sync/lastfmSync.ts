import type { DbHandle } from '@bftp/db';
import type { LastfmClient } from '../lastfm/client.js';
import { EntityStore } from './entityStore.js';
import { rebuildStats } from './stats.js';

const SCROBBLES_SOURCE = 'lastfm:scrobbles';
const LOVED_SOURCE = 'lastfm:loved';

/**
 * Checkpoint for scrobble syncing. A sync run works through a fixed window
 * (from, to]: the window's page boundaries never move even while the user
 * keeps scrobbling, which makes per-page resume safe. Pages are processed
 * oldest-first (totalPages down to 1). `lastUts` is the high-water mark of
 * fully completed windows and becomes `from` for the next run.
 */
export interface ScrobbleCursor {
  lastUts?: number;
  window?: {
    from: number;
    to: number;
    nextPage: number;
    totalPages: number;
  };
}

export interface SyncProgress {
  phase: 'scrobbles' | 'loved' | 'stats';
  page?: number;
  totalPages?: number;
  inserted: number;
}

export interface LastfmSyncResult {
  scrobblesInserted: number;
  lovedCount: number;
}

export class LastfmSync {
  private readonly store: EntityStore;

  constructor(
    private readonly handle: DbHandle,
    private readonly client: LastfmClient,
    private readonly username: string,
    private readonly onProgress: (p: SyncProgress) => void = () => {},
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.store = new EntityStore(handle.sqlite);
  }

  async run(): Promise<LastfmSyncResult> {
    const scrobblesInserted = await this.syncScrobbles();
    const lovedCount = await this.syncLoved();
    this.onProgress({ phase: 'stats', inserted: scrobblesInserted });
    rebuildStats(this.handle.sqlite);
    return { scrobblesInserted, lovedCount };
  }

  private readCursor(source: string): ScrobbleCursor {
    const row = this.handle.sqlite
      .prepare('SELECT cursor FROM sync_state WHERE source = ?')
      .get(source) as { cursor: string | null } | undefined;
    if (!row?.cursor) return {};
    try {
      return JSON.parse(row.cursor) as ScrobbleCursor;
    } catch {
      return {};
    }
  }

  private writeState(source: string, cursor: unknown, status: string, error?: string): void {
    this.handle.sqlite
      .prepare(
        `INSERT INTO sync_state (source, cursor, status, error, last_synced_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET
           cursor = excluded.cursor, status = excluded.status,
           error = excluded.error, last_synced_at = excluded.last_synced_at`,
      )
      .run(source, JSON.stringify(cursor), status, error ?? null, Math.floor(Date.now() / 1000));
  }

  async syncScrobbles(): Promise<number> {
    const cursor = this.readCursor(SCROBBLES_SOURCE);
    let inserted = 0;
    try {
      // Resume an interrupted window, else open a new one from the high-water mark.
      let window = cursor.window;
      if (!window) {
        const from = cursor.lastUts ?? 0;
        const to = this.now();
        const first = await this.client.getRecentTracks(this.username, { from, to, page: 1 });
        if (first.total === 0) {
          // Back off the high-water mark by 1s so a scrobble landing exactly at
          // the boundary is never skipped, whatever the API's from/to
          // inclusivity; the scrobble unique index absorbs the overlap.
          this.writeState(SCROBBLES_SOURCE, { lastUts: to - 1 }, 'idle');
          return 0;
        }
        window = { from, to, nextPage: first.totalPages, totalPages: first.totalPages };
        this.writeState(SCROBBLES_SOURCE, { ...cursor, window }, 'running');
      } else {
        this.writeState(SCROBBLES_SOURCE, cursor, 'running');
      }

      const insertScrobble = this.handle.sqlite.prepare(
        'INSERT OR IGNORE INTO scrobbles (track_id, album_id, uts) VALUES (?, ?, ?)',
      );

      for (let page = window.nextPage; page >= 1; page--) {
        this.onProgress({
          phase: 'scrobbles',
          page: window.totalPages - page + 1,
          totalPages: window.totalPages,
          inserted,
        });
        const res = await this.client.getRecentTracks(this.username, {
          from: window.from,
          to: window.to,
          page,
        });
        const applyPage = this.handle.sqlite.transaction(() => {
          for (const s of res.scrobbles) {
            if (!s.artist || !s.track) continue;
            const artistId = this.store.getOrCreateArtist(s.artist, s.artistMbid);
            const albumId = s.album
              ? this.store.getOrCreateAlbum(artistId, s.album, s.albumMbid)
              : null;
            const trackId = this.store.getOrCreateTrack(artistId, s.track, s.trackMbid);
            const result = insertScrobble.run(trackId, albumId, s.uts);
            inserted += result.changes;
          }
          const nextCursor: ScrobbleCursor =
            page > 1
              ? { lastUts: cursor.lastUts, window: { ...window!, nextPage: page - 1 } }
              : { lastUts: window!.to - 1 }; // -1: see boundary note above

          this.writeState(SCROBBLES_SOURCE, nextCursor, page > 1 ? 'running' : 'idle');
        });
        applyPage();
      }
      return inserted;
    } catch (err) {
      const current = this.readCursor(SCROBBLES_SOURCE);
      this.writeState(SCROBBLES_SOURCE, current, 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** Loved tracks are a small list: fetch fully and replace the lastfm rows. */
  async syncLoved(): Promise<number> {
    try {
      this.writeState(LOVED_SOURCE, {}, 'running');
      const entries: { trackId: number; uts?: number }[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        this.onProgress({ phase: 'loved', page, totalPages, inserted: entries.length });
        const res = await this.client.getLovedTracks(this.username, page);
        totalPages = res.totalPages;
        for (const t of res.loved) {
          if (!t.artist || !t.track) continue;
          const artistId = this.store.getOrCreateArtist(t.artist, t.artistMbid);
          const trackId = this.store.getOrCreateTrack(artistId, t.track, t.trackMbid);
          entries.push({ trackId, uts: t.uts });
        }
        page++;
      } while (page <= totalPages);

      const replace = this.handle.sqlite.transaction(() => {
        this.handle.sqlite.prepare("DELETE FROM liked_tracks WHERE source = 'lastfm'").run();
        const ins = this.handle.sqlite.prepare(
          "INSERT OR IGNORE INTO liked_tracks (track_id, source, liked_at) VALUES (?, 'lastfm', ?)",
        );
        for (const e of entries) ins.run(e.trackId, e.uts ?? null);
      });
      replace();
      this.writeState(LOVED_SOURCE, {}, 'idle');
      return entries.length;
    } catch (err) {
      this.writeState(LOVED_SOURCE, {}, 'error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}
