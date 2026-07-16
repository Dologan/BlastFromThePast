import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import {
  compileRecipe,
  GenreResolver,
  type GenreRule,
  type Recipe,
  type CompileContext,
} from '@bftp/core';
import { rebuildStats } from '../src/sync/stats.js';

/**
 * Executes compiled recipe SQL against a seeded in-memory DB. This is the real
 * proof the compiler works: the generated SQL must run and return the right
 * rows/counts for every clause, sort and cap.
 */
const NOW = 1_800_000_000; // fixed reference "now"
const DAY = 86400;
const YEAR = 365 * DAY;

describe('compileRecipe (executed)', () => {
  let handle: DbHandle;
  let ctx: CompileContext;

  const run = (recipe: Recipe) => {
    const compiled = compileRecipe(recipe, ctx);
    const rows = handle.sqlite.prepare(compiled.sql).all(...(compiled.params as any[])) as any[];
    const count = (
      handle.sqlite.prepare(compiled.countSql).get(...(compiled.countParams as any[])) as {
        c: number;
      }
    ).c;
    return { rows, count };
  };

  beforeEach(() => {
    handle = openDb(':memory:');
    const s = handle.sqlite;

    const rules: GenreRule[] = [
      { pattern: 'metal', genre: 'metal', parent: null },
      { pattern: 'progressive metal', genre: 'progressive metal', parent: 'metal' },
      { pattern: 'death metal', genre: 'death metal', parent: 'metal' },
      { pattern: 'pop', genre: 'pop', parent: null },
    ];
    const resolver = new GenreResolver(rules);

    const tagId = (name: string): number => {
      const existing = s.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number } | undefined;
      return existing?.id ?? Number(s.prepare('INSERT INTO tags (name) VALUES (?)').run(name).lastInsertRowid);
    };

    // Artists (with country + tags), a track each, scrobbles shaping the stats.
    const mkArtist = (name: string, country: string, tags: string[]) => {
      const id = Number(
        s.prepare('INSERT INTO artists (name, name_normalized, country) VALUES (?, ?, ?)').run(name, name.toLowerCase(), country).lastInsertRowid,
      );
      for (const tag of tags) {
        s.prepare("INSERT INTO artist_tags (artist_id, tag_id, source, weight) VALUES (?, ?, 'musicbrainz', 10)").run(id, tagId(tag));
      }
      return id;
    };
    const mkTrackWithScrobbles = (
      artistId: number,
      trackName: string,
      albumName: string,
      utsList: number[],
    ) => {
      const albumId = Number(
        s.prepare('INSERT INTO albums (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(artistId, albumName, albumName.toLowerCase()).lastInsertRowid,
      );
      const trackId = Number(
        s.prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(artistId, trackName, trackName.toLowerCase()).lastInsertRowid,
      );
      for (const uts of utsList) {
        s.prepare('INSERT INTO scrobbles (track_id, album_id, uts) VALUES (?, ?, ?)').run(trackId, albumId, uts);
      }
      return { albumId, trackId };
    };

    // Opeth: progressive metal, SE. Played heavily long ago, not recently.
    const opeth = mkArtist('Opeth', 'SE', ['progressive metal']);
    const opethTrack = mkTrackWithScrobbles(opeth, 'Ghost of Perdition', 'Ghost Reveries', [
      NOW - 5 * YEAR,
      NOW - 5 * YEAR + DAY,
      NOW - 5 * YEAR + 2 * DAY,
      NOW - 4 * YEAR, // last listen ~4y ago
    ]);
    // Boygenius: pop-ish, US. Played recently, once.
    const bg = mkArtist('Boygenius', 'US', ['pop']);
    mkTrackWithScrobbles(bg, 'Not Strong Enough', 'The Record', [NOW - 10 * DAY]);
    // Death: death metal, US. Moderate, mid-range recency.
    const death = mkArtist('Death', 'US', ['death metal']);
    mkTrackWithScrobbles(death, 'Crystal Mountain', 'Symbolic', [NOW - 2 * YEAR, NOW - 2 * YEAR + DAY]);

    // Loved: mark Opeth's track loved (lastfm).
    s.prepare("INSERT INTO liked_tracks (track_id, source, liked_at) VALUES (?, 'lastfm', ?)").run(opethTrack.trackId, NOW - 5 * YEAR);

    // Rebuild stats from scrobbles.
    const allTags = (s.prepare('SELECT name FROM tags').all() as { name: string }[]).map((r) => r.name);
    ctx = {
      nowSeconds: NOW,
      resolveGenreTags: (anyOf, mode) => {
        const set = new Set<string>();
        for (const g of anyOf) for (const t of resolver.tagsMatchingGenre(g, allTags, mode)) set.add(t);
        return [...set];
      },
    };
    // Materialize stats using the same routine the app uses.
    rebuildStats(s);
  });

  afterEach(() => handle.close());

  const output = (over: Partial<Recipe['output']> = {}): Recipe['output'] => ({
    mode: 'tracks',
    sort: 'playcount_desc',
    limit: 50,
    ...over,
  });

  it('returns everything when there are no filters (albums grain)', () => {
    const { rows, count } = run({ filters: [], output: output({ mode: 'albums' }) });
    expect(count).toBe(3);
    expect(rows).toHaveLength(3);
    expect(rows[0].entity_kind).toBe('album');
  });

  it('filters by genre family (metal matches prog + death metal, not pop)', () => {
    const { rows, count } = run({
      filters: [{ type: 'genre', anyOf: ['metal'] }],
      output: output(),
    });
    expect(count).toBe(2);
    expect(rows.map((r) => r.artist_name).sort()).toEqual(['Death', 'Opeth']);
  });

  it('filters by specific subgenre', () => {
    const { rows } = run({
      filters: [{ type: 'genre', anyOf: ['progressive metal'] }],
      output: output(),
    });
    expect(rows.map((r) => r.artist_name)).toEqual(['Opeth']);
  });

  it('filters by country, and by negated country', () => {
    expect(run({ filters: [{ type: 'country', anyOf: ['US'] }], output: output() }).count).toBe(2);
    expect(
      run({ filters: [{ type: 'country', anyOf: ['US'], negate: true }], output: output() }).rows.map(
        (r) => r.artist_name,
      ),
    ).toEqual(['Opeth']);
  });

  it('"not played in 3 years" surfaces long-neglected tracks only', () => {
    const { rows } = run({
      filters: [{ type: 'notPlayedInDays', days: 3 * 365 }],
      output: output(),
    });
    expect(rows.map((r) => r.artist_name)).toEqual(['Opeth']);
  });

  it('combines clauses with AND (metal + not played in 3y)', () => {
    const { rows } = run({
      filters: [
        { type: 'genre', anyOf: ['metal'] },
        { type: 'notPlayedInDays', days: 3 * 365 },
      ],
      output: output(),
    });
    expect(rows.map((r) => r.artist_name)).toEqual(['Opeth']); // Death was played 2y ago
  });

  it('filters by first-listen date range', () => {
    const { count } = run({
      filters: [{ type: 'firstListen', after: '2010-01-01', before: '2100-01-01' }],
      output: output(),
    });
    expect(count).toBe(3);
    const none = run({
      filters: [{ type: 'firstListen', before: '2000-01-01' }],
      output: output(),
    });
    expect(none.count).toBe(0);
  });

  it('filters by playcount range', () => {
    const { rows } = run({
      filters: [{ type: 'playcount', min: 3 }],
      output: output(),
    });
    expect(rows.map((r) => r.artist_name)).toEqual(['Opeth']); // 4 plays
  });

  it('filters by loved', () => {
    const { rows } = run({ filters: [{ type: 'loved' }], output: output() });
    expect(rows.map((r) => r.artist_name)).toEqual(['Opeth']);
    expect(run({ filters: [{ type: 'loved', source: 'spotify' }], output: output() }).count).toBe(0);
  });

  it('neglect sort ranks played-a-lot-but-long-ago first', () => {
    const { rows } = run({ filters: [], output: output({ sort: 'neglect' }) });
    expect(rows[0].artist_name).toBe('Opeth');
  });

  it('applies a per-artist diversity cap', () => {
    // Give Opeth a second track so the cap has something to trim.
    const opethId = (handle.sqlite.prepare("SELECT id FROM artists WHERE name='Opeth'").get() as any).id;
    const t2 = Number(
      handle.sqlite.prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(opethId, 'Windowpane', 'windowpane').lastInsertRowid,
    );
    handle.sqlite.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t2, NOW - 5 * YEAR);
    rebuildStats(handle.sqlite);

    const uncapped = run({ filters: [{ type: 'genre', anyOf: ['metal'] }], output: output() });
    expect(uncapped.rows.filter((r) => r.artist_name === 'Opeth').length).toBe(2);

    const capped = run({
      filters: [{ type: 'genre', anyOf: ['metal'] }],
      output: output({ perArtistCap: 1 }),
    });
    expect(capped.rows.filter((r) => r.artist_name === 'Opeth').length).toBe(1);
  });

  it('respects the limit', () => {
    const { rows, count } = run({ filters: [], output: output({ limit: 2 }) });
    expect(count).toBe(3); // count ignores limit
    expect(rows).toHaveLength(2);
  });

  it('weighted_random sort runs and returns all matching rows', () => {
    const { rows } = run({ filters: [], output: output({ sort: 'weighted_random' }) });
    expect(rows).toHaveLength(3);
  });

  it('anniversary matches tracks first-listened near today (any year)', () => {
    // Add a track first listened exactly one year before NOW (same calendar day).
    const opethId = (handle.sqlite.prepare("SELECT id FROM artists WHERE name='Opeth'").get() as any).id;
    const anniv = Number(
      handle.sqlite.prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(opethId, 'Harvest', 'harvest').lastInsertRowid,
    );
    handle.sqlite.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(anniv, NOW - YEAR);
    // And one first-listened ~6 months off, which must NOT match a tight window.
    const off = Number(
      handle.sqlite.prepare('INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, ?, ?)').run(opethId, 'Benighted', 'benighted').lastInsertRowid,
    );
    handle.sqlite.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(off, NOW - Math.floor(YEAR / 2));
    rebuildStats(handle.sqlite);

    const names = run({
      filters: [{ type: 'anniversary', field: 'firstListen', windowDays: 3 }],
      output: output({ limit: 100 }),
    }).rows.map((r) => r.name);
    expect(names).toContain('Harvest');
    expect(names).not.toContain('Benighted');
  });
});
