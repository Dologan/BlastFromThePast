import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { Enrichment } from '../src/enrich/enrichment.js';
import type { LastfmClient, WeightedTag } from '../src/lastfm/client.js';
import type { MbArtist, MbSearchHit, MusicBrainzClient } from '../src/enrich/musicbrainz.js';

class FakeMb {
  records = new Map<string, MbArtist>();
  searches = new Map<string, MbSearchHit>();
  searchCalls = 0;
  lookupCalls = 0;
  failLookupFor: string | null = null;
  delayMs = 0;

  async searchArtist(name: string): Promise<MbSearchHit | null> {
    this.searchCalls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.searches.get(name.toLowerCase()) ?? null;
  }
  async lookupArtist(mbid: string): Promise<MbArtist | null> {
    this.lookupCalls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failLookupFor === mbid) throw new Error('MB 503');
    return this.records.get(mbid) ?? null;
  }
}

class FakeLastfm {
  tags = new Map<string, WeightedTag[]>();
  calls = 0;
  delayMs = 0;

  async getArtistTopTags(artist: { name: string }): Promise<WeightedTag[]> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return this.tags.get(artist.name.toLowerCase()) ?? [];
  }
}

describe('Enrichment', () => {
  let handle: DbHandle;
  let mb: FakeMb;
  let lastfm: FakeLastfm;

  const addArtist = (name: string, mbid: string | null = null): number =>
    Number(
      handle.sqlite
        .prepare('INSERT INTO artists (name, name_normalized, mbid) VALUES (?, ?, ?)')
        .run(name, name.toLowerCase(), mbid).lastInsertRowid,
    );

  const makeEnrichment = () =>
    new Enrichment(handle, mb as unknown as MusicBrainzClient, lastfm as unknown as LastfmClient);

  const artistRow = (id: number) =>
    handle.sqlite.prepare('SELECT * FROM artists WHERE id = ?').get(id) as any;

  const tagsFor = (id: number): { name: string; source: string; weight: number }[] =>
    handle.sqlite
      .prepare(
        `SELECT t.name, at.source, at.weight FROM artist_tags at
         JOIN tags t ON t.id = at.tag_id WHERE at.artist_id = ? ORDER BY t.name, at.source`,
      )
      .all(id) as any;

  beforeEach(() => {
    handle = openDb(':memory:');
    mb = new FakeMb();
    lastfm = new FakeLastfm();
  });
  afterEach(() => handle.close());

  it('enriches an artist that already has an MBID (no search needed)', async () => {
    const id = addArtist('Opeth', 'mbid-opeth');
    mb.records.set('mbid-opeth', {
      mbid: 'mbid-opeth',
      country: 'SE',
      genres: [{ name: 'Progressive Metal', weight: 5 }],
      tags: [{ name: 'swedish', weight: 2 }],
    });
    lastfm.tags.set('opeth', [{ name: 'progressive metal', weight: 100 }]);

    const result = await makeEnrichment().run();

    expect(result).toEqual({ processed: 1, withCountry: 1, failed: 0 });
    expect(mb.searchCalls).toBe(0); // mbid already known, no search needed
    const row = artistRow(id);
    expect(row.country).toBe('SE');
    expect(row.enrich_status).toBe('done');
    expect(tagsFor(id)).toEqual([
      { name: 'progressive metal', source: 'lastfm', weight: 100 },
      { name: 'progressive metal', source: 'musicbrainz', weight: 5 },
      { name: 'swedish', source: 'musicbrainz', weight: 2 },
    ]);
  });

  it('resolves an MBID by name only above the confidence threshold', async () => {
    const good = addArtist('Katatonia');
    const weak = addArtist('Obscure Local Band');
    mb.searches.set('katatonia', { mbid: 'mbid-kata', score: 100, country: 'SE' });
    mb.searches.set('obscure local band', { mbid: 'mbid-weak', score: 40, country: 'US' });
    mb.records.set('mbid-kata', { mbid: 'mbid-kata', country: 'SE', genres: [], tags: [] });
    mb.records.set('mbid-weak', { mbid: 'mbid-weak', country: 'US', genres: [], tags: [] });
    lastfm.tags.set('obscure local band', [{ name: 'lo-fi', weight: 30 }]);

    await makeEnrichment().run();

    expect(artistRow(good).country).toBe('SE');
    expect(artistRow(good).mbid).toBe('mbid-kata');
    // Weak match: no mbid/country adopted, but Last.fm tags still captured and
    // the artist is still marked done (terminal, not retried).
    const weakRow = artistRow(weak);
    expect(weakRow.country).toBeNull();
    expect(weakRow.mbid).toBeNull();
    expect(weakRow.enrich_status).toBe('done');
    expect(tagsFor(weak)).toEqual([{ name: 'lo-fi', source: 'lastfm', weight: 30 }]);
  });

  it('preserves partial success and resumes only the failed lane on retry', async () => {
    const id = addArtist('Ulver', 'mbid-ulver');
    mb.records.set('mbid-ulver', { mbid: 'mbid-ulver', country: 'NO', genres: [], tags: [] });
    lastfm.tags.set('ulver', [{ name: 'black metal', weight: 50 }]);
    mb.failLookupFor = 'mbid-ulver';

    const first = await makeEnrichment().run();
    expect(first.failed).toBe(1);
    expect(lastfm.calls).toBe(1);
    const afterFirst = artistRow(id);
    expect(afterFirst.enrich_status).toBe('error');
    // Last.fm succeeded and was saved despite the MusicBrainz failure.
    expect(tagsFor(id)).toEqual([{ name: 'black metal', source: 'lastfm', weight: 50 }]);

    mb.failLookupFor = null;
    const second = await makeEnrichment().run();
    expect(second.failed).toBe(0);
    expect(lastfm.calls).toBe(1); // not re-fetched: already cached
    expect(mb.lookupCalls).toBe(2); // only the failed MB lookup was retried
    const afterSecond = artistRow(id);
    expect(afterSecond.enrich_status).toBe('done');
    expect(afterSecond.country).toBe('NO');
  });

  it('does not re-fetch already-done artists', async () => {
    const id = addArtist('Anathema', 'mbid-ana');
    mb.records.set('mbid-ana', { mbid: 'mbid-ana', country: 'GB', genres: [], tags: [] });
    await makeEnrichment().run();
    const callsAfterFirst = { lookup: mb.lookupCalls, lastfm: lastfm.calls };

    const second = await makeEnrichment().run();
    expect(second.processed).toBe(0);
    expect(mb.lookupCalls).toBe(callsAfterFirst.lookup);
    expect(lastfm.calls).toBe(callsAfterFirst.lastfm);
    expect(artistRow(id).country).toBe('GB');
  });

  it('runs the MusicBrainz and Last.fm lanes concurrently, not serially', async () => {
    const n = 5;
    for (let i = 0; i < n; i++) {
      addArtist(`Artist ${i}`, `mbid-${i}`);
      mb.records.set(`mbid-${i}`, { mbid: `mbid-${i}`, country: 'SE', genres: [], tags: [] });
    }
    mb.delayMs = 20;
    lastfm.delayMs = 20;

    const start = Date.now();
    await makeEnrichment().run();
    const elapsed = Date.now() - start;

    // Serial would take roughly n*20 (MB) + n*20 (Last.fm) = 200ms; running
    // the lanes concurrently should land close to max(20,20)*n = 100ms.
    // Generous upper bound to avoid CI flakiness while still catching a
    // regression back to serial fetching.
    expect(elapsed).toBeLessThan(170);
  });

  it('reprocessAll re-derives from cache alone with zero network calls', async () => {
    const id = addArtist('Opeth', 'mbid-opeth');
    mb.records.set('mbid-opeth', {
      mbid: 'mbid-opeth',
      country: 'SE',
      genres: [{ name: 'progressive metal', weight: 5 }],
      tags: [],
    });
    lastfm.tags.set('opeth', [{ name: 'metal', weight: 80 }]);
    await makeEnrichment().run();
    const callsAfterRun = { search: mb.searchCalls, lookup: mb.lookupCalls, lastfm: lastfm.calls };

    // Simulate rebuilding the normalized schema from scratch.
    handle.sqlite.exec('DELETE FROM artist_tags; DELETE FROM tags;');
    handle.sqlite.prepare('UPDATE artists SET country = NULL WHERE id = ?').run(id);

    const reprocessor = new Enrichment(handle, null, null);
    const result = reprocessor.reprocessAll();

    expect(result).toEqual({ processed: 1, withCountry: 1 });
    expect(mb.searchCalls).toBe(callsAfterRun.search);
    expect(mb.lookupCalls).toBe(callsAfterRun.lookup);
    expect(lastfm.calls).toBe(callsAfterRun.lastfm);
    expect(artistRow(id).country).toBe('SE');
    expect(tagsFor(id)).toEqual([
      { name: 'metal', source: 'lastfm', weight: 80 },
      { name: 'progressive metal', source: 'musicbrainz', weight: 5 },
    ]);
  });

  it('reprocessAll leaves never-fetched artists untouched', async () => {
    const fetched = addArtist('Opeth', 'mbid-opeth');
    mb.records.set('mbid-opeth', { mbid: 'mbid-opeth', country: 'SE', genres: [], tags: [] });
    await makeEnrichment().run();
    // Added after run() so it was never part of a pendingArtists() fetch pass.
    const neverFetched = addArtist('Some New Artist');

    const reprocessor = new Enrichment(handle, null, null);
    const result = reprocessor.reprocessAll();

    expect(result.processed).toBe(1); // only the previously-fetched artist
    expect(artistRow(neverFetched).enrich_status).toBe('pending');
    expect(artistRow(neverFetched).country).toBeNull();
    expect(artistRow(fetched).country).toBe('SE');
  });

  it('run() throws without live clients', async () => {
    const enrichment = new Enrichment(handle, null, null);
    await expect(enrichment.run()).rejects.toThrow(/requires MusicBrainz and Last\.fm clients/);
  });
});
