import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { Enrichment } from '../src/enrich/enrichment.js';
import type { LastfmClient, WeightedTag } from '../src/lastfm/client.js';
import type { MbArtist, MbSearchHit, MusicBrainzClient } from '../src/enrich/musicbrainz.js';

class FakeMb {
  records = new Map<string, MbArtist>();
  searches = new Map<string, MbSearchHit>();
  lookups = 0;
  failLookupFor: string | null = null;

  async searchArtist(name: string): Promise<MbSearchHit | null> {
    return this.searches.get(name.toLowerCase()) ?? null;
  }
  async lookupArtist(mbid: string): Promise<MbArtist | null> {
    this.lookups++;
    if (this.failLookupFor === mbid) throw new Error('MB 503');
    return this.records.get(mbid) ?? null;
  }
}

class FakeLastfm {
  tags = new Map<string, WeightedTag[]>();
  async getArtistTopTags(artist: { name: string }): Promise<WeightedTag[]> {
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
    const row = artistRow(id);
    expect(row.country).toBe('SE');
    expect(row.enrich_status).toBe('done');
    // MB genres + tags stored under 'musicbrainz', Last.fm tags under 'lastfm',
    // all tag names lowercased.
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

  it('marks transient failures as error and resumes them on re-run', async () => {
    const id = addArtist('Ulver', 'mbid-ulver');
    mb.records.set('mbid-ulver', { mbid: 'mbid-ulver', country: 'NO', genres: [], tags: [] });
    mb.failLookupFor = 'mbid-ulver';

    const first = await makeEnrichment().run();
    expect(first.failed).toBe(1);
    expect(artistRow(id).enrich_status).toBe('error');

    // Recover and re-run: only the errored artist is retried.
    mb.failLookupFor = null;
    const second = await makeEnrichment().run();
    expect(second.processed).toBe(1);
    expect(second.failed).toBe(0);
    expect(artistRow(id).country).toBe('NO');
    expect(artistRow(id).enrich_status).toBe('done');
  });

  it('does not re-process already-done artists', async () => {
    const id = addArtist('Anathema', 'mbid-ana');
    mb.records.set('mbid-ana', { mbid: 'mbid-ana', country: 'GB', genres: [], tags: [] });
    await makeEnrichment().run();
    const lookupsAfterFirst = mb.lookups;

    const second = await makeEnrichment().run();
    expect(second.processed).toBe(0);
    expect(mb.lookups).toBe(lookupsAfterFirst); // no further MB calls
    expect(artistRow(id).country).toBe('GB');
  });
});
