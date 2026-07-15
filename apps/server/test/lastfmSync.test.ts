import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { LastfmSync } from '../src/sync/lastfmSync.js';
import type {
  LastfmClient,
  LastfmScrobble,
  RecentTracksPage,
  LovedTrack,
  LovedTracksPage,
} from '../src/lastfm/client.js';

const PAGE_SIZE = 5;

/**
 * In-memory stand-in for the Last.fm API: newest-first ordering, from/to
 * window filtering, fixed page size, optional injected failures.
 */
class FakeLastfmClient {
  scrobbles: LastfmScrobble[] = [];
  loved: LovedTrack[] = [];
  requestCount = 0;
  failOnRequest: number | null = null;

  async getRecentTracks(
    _user: string,
    opts: { from?: number; to?: number; page?: number } = {},
  ): Promise<RecentTracksPage> {
    this.requestCount++;
    if (this.failOnRequest !== null && this.requestCount === this.failOnRequest) {
      throw new Error('injected failure');
    }
    const from = opts.from ?? 0;
    const to = opts.to ?? Number.MAX_SAFE_INTEGER;
    const inWindow = this.scrobbles
      .filter((s) => s.uts >= from && s.uts <= to)
      .sort((a, b) => b.uts - a.uts);
    const page = opts.page ?? 1;
    const totalPages = Math.max(1, Math.ceil(inWindow.length / PAGE_SIZE));
    return {
      scrobbles: inWindow.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      page,
      totalPages,
      total: inWindow.length,
    };
  }

  async getLovedTracks(_user: string, page = 1): Promise<LovedTracksPage> {
    this.requestCount++;
    const totalPages = Math.max(1, Math.ceil(this.loved.length / PAGE_SIZE));
    return {
      loved: this.loved.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      page,
      totalPages,
    };
  }
}

const DAY = 86400;
const T0 = 1_600_000_000;

function scrobble(artist: string, track: string, uts: number, album?: string): LastfmScrobble {
  return { artist, track, uts, album };
}

describe('LastfmSync', () => {
  let handle: DbHandle;
  let client: FakeLastfmClient;

  const makeSync = (now: number) =>
    new LastfmSync(handle, client as unknown as LastfmClient, 'testuser', () => {}, () => now);

  const count = (sql: string): number =>
    (handle.sqlite.prepare(sql).get() as { c: number }).c;

  beforeEach(() => {
    handle = openDb(':memory:');
    client = new FakeLastfmClient();
  });

  afterEach(() => handle.close());

  it('backfills a multi-page history and materializes stats', async () => {
    // 12 scrobbles => 3 pages of 5. Track A played 3x in one month (its peak).
    for (let i = 0; i < 9; i++) {
      client.scrobbles.push(scrobble('Opeth', `Song ${i}`, T0 + i * DAY, 'Damnation'));
    }
    client.scrobbles.push(scrobble('Opeth', 'Song 0', T0 + 40 * DAY));
    client.scrobbles.push(scrobble('Opeth', 'Song 0', T0 + 41 * DAY));
    client.scrobbles.push(scrobble('Katatonia', 'Lethean', T0 + 50 * DAY));

    const result = await makeSync(T0 + 60 * DAY).run();

    expect(result.scrobblesInserted).toBe(12);
    expect(count('SELECT COUNT(*) c FROM scrobbles')).toBe(12);
    expect(count('SELECT COUNT(*) c FROM artists')).toBe(2);
    expect(count('SELECT COUNT(*) c FROM tracks')).toBe(10);
    expect(count('SELECT COUNT(*) c FROM albums')).toBe(1);

    const stats = handle.sqlite
      .prepare(
        `SELECT s.* FROM track_stats s JOIN tracks t ON t.id = s.track_id WHERE t.name = 'Song 0'`,
      )
      .get() as any;
    expect(stats.playcount).toBe(3);
    expect(stats.first_listen).toBe(T0);
    expect(stats.last_listen).toBe(T0 + 41 * DAY);
    // Two plays fall in the month of T0+40d/41d vs one at T0.
    const peakMonth = new Date((T0 + 40 * DAY) * 1000).toISOString().slice(0, 7);
    expect(stats.peak_month).toBe(peakMonth);
    expect(stats.peak_month_count).toBe(2);

    expect(count('SELECT COUNT(*) c FROM artist_stats')).toBe(2);
    expect(count('SELECT COUNT(*) c FROM album_stats')).toBe(1);
  });

  it('incremental sync only ingests new scrobbles and never duplicates', async () => {
    for (let i = 0; i < 7; i++) {
      client.scrobbles.push(scrobble('Ulver', `Track ${i}`, T0 + i * DAY));
    }
    await makeSync(T0 + 10 * DAY).run();
    expect(count('SELECT COUNT(*) c FROM scrobbles')).toBe(7);

    client.scrobbles.push(scrobble('Ulver', 'Track 0', T0 + 11 * DAY));
    client.scrobbles.push(scrobble('Ulver', 'New One', T0 + 12 * DAY));

    const second = await makeSync(T0 + 13 * DAY).run();
    expect(second.scrobblesInserted).toBe(2);
    expect(count('SELECT COUNT(*) c FROM scrobbles')).toBe(9);

    // Third run with nothing new is a no-op.
    const third = await makeSync(T0 + 14 * DAY).run();
    expect(third.scrobblesInserted).toBe(0);
    expect(count('SELECT COUNT(*) c FROM scrobbles')).toBe(9);
  });

  it('resumes an interrupted backfill from the page checkpoint', async () => {
    for (let i = 0; i < 15; i++) {
      client.scrobbles.push(scrobble('Anathema', `Part ${i}`, T0 + i * DAY));
    }
    // Requests: 1 = discovery (page 1), 2 = page 3 (oldest), 3 = page 2 -> fail.
    client.failOnRequest = 3;
    await expect(makeSync(T0 + 20 * DAY).syncScrobbles()).rejects.toThrow('injected failure');

    const state = handle.sqlite
      .prepare("SELECT * FROM sync_state WHERE source = 'lastfm:scrobbles'")
      .get() as any;
    expect(state.status).toBe('error');
    const cursor = JSON.parse(state.cursor);
    expect(cursor.window.nextPage).toBe(2);
    expect(count('SELECT COUNT(*) c FROM scrobbles')).toBe(5); // only the oldest page landed

    // Retry: resumes the same window without re-reading page 3.
    client.failOnRequest = null;
    const inserted = await makeSync(T0 + 25 * DAY).syncScrobbles();
    expect(inserted).toBe(10);
    expect(count('SELECT COUNT(*) c FROM scrobbles')).toBe(15);
    const after = handle.sqlite
      .prepare("SELECT * FROM sync_state WHERE source = 'lastfm:scrobbles'")
      .get() as any;
    expect(after.status).toBe('idle');
    expect(JSON.parse(after.cursor).window).toBeUndefined();
  });

  it('merges entity identity case-insensitively', async () => {
    client.scrobbles.push(scrobble('Opeth', 'Ghost of Perdition', T0));
    client.scrobbles.push(scrobble('opeth', 'Ghost Of Perdition', T0 + DAY));
    await makeSync(T0 + 2 * DAY).run();
    expect(count('SELECT COUNT(*) c FROM artists')).toBe(1);
    expect(count('SELECT COUNT(*) c FROM tracks')).toBe(1);
    expect(count('SELECT COUNT(*) c FROM scrobbles')).toBe(2);
  });

  it('replaces loved tracks on each sync', async () => {
    client.loved = [
      { artist: 'Opeth', track: 'Windowpane', uts: T0 },
      { artist: 'Katatonia', track: 'Evidence', uts: T0 + DAY },
    ];
    await makeSync(T0 + 2 * DAY).run();
    expect(count("SELECT COUNT(*) c FROM liked_tracks WHERE source = 'lastfm'")).toBe(2);

    // One un-loved, one added.
    client.loved = [
      { artist: 'Katatonia', track: 'Evidence', uts: T0 + DAY },
      { artist: 'Ulver', track: 'Nowhere', uts: T0 + 3 * DAY },
    ];
    await makeSync(T0 + 4 * DAY).run();
    const rows = handle.sqlite
      .prepare(
        `SELECT t.name FROM liked_tracks l JOIN tracks t ON t.id = l.track_id WHERE l.source = 'lastfm' ORDER BY t.name`,
      )
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['Evidence', 'Nowhere']);
  });
});
