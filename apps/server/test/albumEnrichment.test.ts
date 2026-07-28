import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { AlbumEnrichment } from '../src/enrich/albumEnrichment.js';
import type { MbReleaseGroup, MbReleaseSearchHit, MusicBrainzClient } from '../src/enrich/musicbrainz.js';

class FakeMb {
  records = new Map<string, MbReleaseGroup>();
  searches = new Map<string, MbReleaseSearchHit>();
  searchCalls = 0;
  lookupCalls = 0;
  failLookupFor: string | null = null;

  async searchReleaseGroup(artistName: string, albumName: string): Promise<MbReleaseSearchHit | null> {
    this.searchCalls++;
    return this.searches.get(`${artistName.toLowerCase()}::${albumName.toLowerCase()}`) ?? null;
  }
  async lookupReleaseGroup(mbid: string): Promise<MbReleaseGroup | null> {
    this.lookupCalls++;
    if (this.failLookupFor === mbid) throw new Error('MB 503');
    return this.records.get(mbid) ?? null;
  }
}

describe('AlbumEnrichment', () => {
  let handle: DbHandle;
  let mb: FakeMb;

  const addArtist = (name: string): number =>
    Number(
      handle.sqlite
        .prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)')
        .run(name, name.toLowerCase()).lastInsertRowid,
    );

  const addAlbum = (artistId: number, name: string, mbid: string | null = null): number =>
    Number(
      handle.sqlite
        .prepare('INSERT INTO albums (artist_id, name, name_normalized, mbid) VALUES (?, ?, ?, ?)')
        .run(artistId, name, name.toLowerCase(), mbid).lastInsertRowid,
    );

  const makeEnrichment = () => new AlbumEnrichment(handle, mb as unknown as MusicBrainzClient);

  const albumRow = (id: number) => handle.sqlite.prepare('SELECT * FROM albums WHERE id = ?').get(id) as any;

  beforeEach(() => {
    handle = openDb(':memory:');
    mb = new FakeMb();
  });
  afterEach(() => handle.close());

  it('enriches an album that already has an MBID (no search needed)', async () => {
    const artist = addArtist('Opeth');
    const album = addAlbum(artist, 'Ghost Reveries', 'rg-ghost-reveries');
    mb.records.set('rg-ghost-reveries', { firstReleaseDate: '2005-08-24' });

    const result = await makeEnrichment().run();

    expect(result).toEqual({ processed: 1, withDate: 1, failed: 0 });
    expect(mb.searchCalls).toBe(0); // mbid already known, no search needed
    const row = albumRow(album);
    expect(row.release_date).toBe('2005-08-24');
    expect(row.release_date_status).toBe('done');
  });

  it('resolves an MBID by name only above the confidence threshold', async () => {
    const artist = addArtist('Katatonia');
    const good = addAlbum(artist, 'Dead End Kings');
    const weak = addAlbum(artist, 'Obscure Bootleg');
    mb.searches.set('katatonia::dead end kings', { mbid: 'rg-good', score: 100 });
    mb.searches.set('katatonia::obscure bootleg', { mbid: 'rg-weak', score: 40 });
    mb.records.set('rg-good', { firstReleaseDate: '2012-08-13' });
    mb.records.set('rg-weak', { firstReleaseDate: '1999-01-01' });

    await makeEnrichment().run();

    expect(albumRow(good).release_date).toBe('2012-08-13');
    expect(albumRow(good).mbid).toBe('rg-good');
    // Weak match: no mbid/date adopted, but still marked done (terminal, not retried).
    const weakRow = albumRow(weak);
    expect(weakRow.release_date).toBeNull();
    expect(weakRow.mbid).toBeNull();
    expect(weakRow.release_date_status).toBe('done');
  });

  it('preserves partial success and resumes only the failed lookup on retry', async () => {
    const artist = addArtist('Ulver');
    const album = addAlbum(artist, 'Bergtatt', 'rg-ulver');
    mb.records.set('rg-ulver', { firstReleaseDate: '1995-01-01' });
    mb.failLookupFor = 'rg-ulver';

    const first = await makeEnrichment().run();
    expect(first.failed).toBe(1);
    expect(albumRow(album).release_date_status).toBe('error');

    mb.failLookupFor = null;
    const second = await makeEnrichment().run();
    expect(second.failed).toBe(0);
    expect(mb.lookupCalls).toBe(2); // only the failed lookup was retried
    const row = albumRow(album);
    expect(row.release_date_status).toBe('done');
    expect(row.release_date).toBe('1995-01-01');
  });

  it('does not re-fetch already-done albums', async () => {
    const artist = addArtist('Anathema');
    const album = addAlbum(artist, 'Judgement', 'rg-ana');
    mb.records.set('rg-ana', { firstReleaseDate: '1999-09-27' });
    await makeEnrichment().run();
    const callsAfterFirst = mb.lookupCalls;

    const second = await makeEnrichment().run();
    expect(second.processed).toBe(0);
    expect(mb.lookupCalls).toBe(callsAfterFirst);
    expect(albumRow(album).release_date).toBe('1999-09-27');
  });

  it('reprocessAll re-derives from cache alone with zero network calls', async () => {
    const artist = addArtist('Opeth');
    const album = addAlbum(artist, 'Ghost Reveries', 'rg-ghost-reveries');
    mb.records.set('rg-ghost-reveries', { firstReleaseDate: '2005-08-24' });
    await makeEnrichment().run();
    const callsAfterRun = { search: mb.searchCalls, lookup: mb.lookupCalls };

    // Simulate re-deriving after a schema/parsing change.
    handle.sqlite.prepare('UPDATE albums SET release_date = NULL WHERE id = ?').run(album);

    const reprocessor = new AlbumEnrichment(handle, null);
    const result = reprocessor.reprocessAll();

    expect(result).toEqual({ processed: 1, withDate: 1 });
    expect(mb.searchCalls).toBe(callsAfterRun.search);
    expect(mb.lookupCalls).toBe(callsAfterRun.lookup);
    expect(albumRow(album).release_date).toBe('2005-08-24');
  });

  it('reprocessAll leaves never-fetched albums untouched', async () => {
    const artist = addArtist('Opeth');
    const fetched = addAlbum(artist, 'Ghost Reveries', 'rg-ghost-reveries');
    mb.records.set('rg-ghost-reveries', { firstReleaseDate: '2005-08-24' });
    await makeEnrichment().run();
    // Added after run() so it was never part of a pendingAlbums() fetch pass.
    const neverFetched = addAlbum(artist, 'Some New Album');

    const reprocessor = new AlbumEnrichment(handle, null);
    const result = reprocessor.reprocessAll();

    expect(result.processed).toBe(1); // only the previously-fetched album
    expect(albumRow(neverFetched).release_date_status).toBe('pending');
    expect(albumRow(neverFetched).release_date).toBeNull();
    expect(albumRow(fetched).release_date).toBe('2005-08-24');
  });

  it('run() throws without a live MusicBrainz client', async () => {
    const enrichment = new AlbumEnrichment(handle, null);
    await expect(enrichment.run()).rejects.toThrow(/requires a MusicBrainz client/);
  });
});
