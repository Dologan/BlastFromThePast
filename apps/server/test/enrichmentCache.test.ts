import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { EnrichmentCache } from '../src/enrich/cache.js';

describe('EnrichmentCache', () => {
  let handle: DbHandle;
  afterEach(() => handle?.close());

  it('distinguishes not-cached (undefined) from a cached miss (null) for MB search', () => {
    handle = openDb(':memory:');
    const cache = new EnrichmentCache(handle.sqlite);

    expect(cache.hasMbSearch('Tool')).toBe(false);
    expect(cache.getMbSearch('Tool')).toBeUndefined();

    cache.putMbSearch('Tool', null); // confirmed: no candidate found
    expect(cache.hasMbSearch('Tool')).toBe(true);
    expect(cache.getMbSearch('Tool')).toBeNull();

    cache.putMbSearch('Opeth', { mbid: 'mbid-1', score: 100, country: 'SE' });
    expect(cache.getMbSearch('Opeth')).toEqual({ mbid: 'mbid-1', score: 100, country: 'SE' });
    // Lookups are name-normalized (case/whitespace insensitive).
    expect(cache.getMbSearch('  opeth  ')).toEqual({ mbid: 'mbid-1', score: 100, country: 'SE' });
  });

  it('distinguishes not-cached from a cached 404 for MB artist lookups', () => {
    handle = openDb(':memory:');
    const cache = new EnrichmentCache(handle.sqlite);

    expect(cache.getMbArtist('mbid-x')).toBeUndefined();
    cache.putMbArtist('mbid-x', null);
    expect(cache.getMbArtist('mbid-x')).toBeNull();

    cache.putMbArtist('mbid-y', {
      country: 'NO',
      genres: [{ name: 'black metal', weight: 9 }],
      tags: [],
    });
    expect(cache.getMbArtist('mbid-y')).toEqual({
      country: 'NO',
      genres: [{ name: 'black metal', weight: 9 }],
      tags: [],
    });
  });

  it('keys Last.fm tags by mbid when known, else by normalized name', () => {
    handle = openDb(':memory:');
    const cache = new EnrichmentCache(handle.sqlite);

    cache.putLastfmTags('Opeth', 'mbid-opeth', [{ name: 'progressive metal', weight: 100 }]);
    expect(cache.getLastfmTags('Opeth', 'mbid-opeth')).toEqual([
      { name: 'progressive metal', weight: 100 },
    ]);
    // Same artist looked up without the mbid misses -- distinct cache key.
    expect(cache.getLastfmTags('Opeth', null)).toBeUndefined();

    cache.putLastfmTags('No Mbid Band', null, []);
    // An empty array is itself a valid cached result, not "uncached".
    expect(cache.hasLastfmTags('No Mbid Band', null)).toBe(true);
    expect(cache.getLastfmTags('No Mbid Band', null)).toEqual([]);
  });

  it('upserts overwrite a previously-cached row for the same key', () => {
    handle = openDb(':memory:');
    const cache = new EnrichmentCache(handle.sqlite);
    cache.putMbArtist('mbid-1', { country: 'US', genres: [], tags: [] });
    cache.putMbArtist('mbid-1', { country: 'GB', genres: [], tags: [] });
    expect(cache.getMbArtist('mbid-1')?.country).toBe('GB');
  });

  it('distinguishes not-cached (undefined) from a cached miss (null) for release-group search', () => {
    handle = openDb(':memory:');
    const cache = new EnrichmentCache(handle.sqlite);

    expect(cache.hasReleaseSearch('Opeth', 'Ghost Reveries')).toBe(false);
    expect(cache.getReleaseSearch('Opeth', 'Ghost Reveries')).toBeUndefined();

    cache.putReleaseSearch('Nobody', 'Nothing', null); // confirmed: no candidate found
    expect(cache.hasReleaseSearch('Nobody', 'Nothing')).toBe(true);
    expect(cache.getReleaseSearch('Nobody', 'Nothing')).toBeNull();

    cache.putReleaseSearch('Opeth', 'Ghost Reveries', { mbid: 'rg-1', score: 100 });
    expect(cache.getReleaseSearch('Opeth', 'Ghost Reveries')).toEqual({ mbid: 'rg-1', score: 100 });
    // Lookups are name-normalized (case/whitespace insensitive).
    expect(cache.getReleaseSearch('  opeth  ', '  ghost reveries  ')).toEqual({ mbid: 'rg-1', score: 100 });
    // A different album by the same artist is a distinct cache key.
    expect(cache.getReleaseSearch('Opeth', 'Blackwater Park')).toBeUndefined();
  });

  it('distinguishes not-cached from a cached 404 for release-group lookups', () => {
    handle = openDb(':memory:');
    const cache = new EnrichmentCache(handle.sqlite);

    expect(cache.getReleaseGroup('rg-x')).toBeUndefined();
    cache.putReleaseGroup('rg-x', null);
    expect(cache.getReleaseGroup('rg-x')).toBeNull();

    cache.putReleaseGroup('rg-y', { releaseDate: '2005-08-24' });
    expect(cache.getReleaseGroup('rg-y')).toEqual({ releaseDate: '2005-08-24' });
  });
});
