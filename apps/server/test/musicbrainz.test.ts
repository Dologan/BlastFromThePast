import { describe, it, expect } from 'vitest';
import { MusicBrainzClient } from '../src/enrich/musicbrainz.js';

function fakeFetch(responses: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const body = responses[url];
    if (body === undefined) return { ok: false, status: 404, json: async () => undefined };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetchImpl, calls };
}

const opts = { minIntervalMs: 0, sleep: async () => {} };

describe('MusicBrainzClient', () => {
  it('parses genres, tags and prefers the ISO country code', async () => {
    const url =
      'https://musicbrainz.org/ws/2/artist/mbid-1?inc=genres+tags&fmt=json';
    const { fetchImpl } = fakeFetch({
      [url]: {
        id: 'mbid-1',
        country: 'NO',
        area: { name: 'Norway', 'iso-3166-1-codes': ['NO'] },
        genres: [{ name: 'black metal', count: 9 }],
        tags: [{ name: 'norwegian', count: 3 }],
      },
    });
    const mb = new MusicBrainzClient('test/1.0', { ...opts, fetchImpl });
    const record = await mb.lookupArtist('mbid-1');
    expect(record).toEqual({
      mbid: 'mbid-1',
      country: 'NO',
      genres: [{ name: 'black metal', weight: 9 }],
      tags: [{ name: 'norwegian', weight: 3 }],
    });
  });

  it('falls back to the area ISO code when country is absent', async () => {
    const url = 'https://musicbrainz.org/ws/2/artist/mbid-2?inc=genres+tags&fmt=json';
    const { fetchImpl } = fakeFetch({
      [url]: {
        id: 'mbid-2',
        area: { name: 'England', 'iso-3166-1-codes': ['GB'] },
        genres: [],
        tags: [],
      },
    });
    const mb = new MusicBrainzClient('test/1.0', { ...opts, fetchImpl });
    const record = await mb.lookupArtist('mbid-2');
    expect(record?.country).toBe('GB');
  });

  it('returns null for an unknown artist (404)', async () => {
    const { fetchImpl } = fakeFetch({});
    const mb = new MusicBrainzClient('test/1.0', { ...opts, fetchImpl });
    expect(await mb.lookupArtist('nope')).toBeNull();
  });

  it('returns the top search hit with its score', async () => {
    const url =
      'https://musicbrainz.org/ws/2/artist?query=' +
      encodeURIComponent('artist:"Tool"') +
      '&limit=3&fmt=json';
    const { fetchImpl } = fakeFetch({
      [url]: { artists: [{ id: 'mbid-tool', score: 100, country: 'US' }] },
    });
    const mb = new MusicBrainzClient('test/1.0', { ...opts, fetchImpl });
    expect(await mb.searchArtist('Tool')).toEqual({
      mbid: 'mbid-tool',
      score: 100,
      country: 'US',
    });
  });

  it('searchReleaseGroup returns the top release-group hit with its score', async () => {
    const url =
      'https://musicbrainz.org/ws/2/release-group?query=' +
      encodeURIComponent('releasegroup:"Ghost Reveries" AND artist:"Opeth"') +
      '&limit=3&fmt=json';
    const { fetchImpl } = fakeFetch({
      [url]: { 'release-groups': [{ id: 'rg-1', score: 100, title: 'Ghost Reveries' }] },
    });
    const mb = new MusicBrainzClient('test/1.0', { ...opts, fetchImpl });
    expect(await mb.searchReleaseGroup('Opeth', 'Ghost Reveries')).toEqual({ mbid: 'rg-1', score: 100 });
  });

  it('searchReleaseGroup returns null when no candidate is found', async () => {
    const { fetchImpl } = fakeFetch({});
    const mb = new MusicBrainzClient('test/1.0', { ...opts, fetchImpl });
    expect(await mb.searchReleaseGroup('Nobody', 'Nothing')).toBeNull();
  });

  it('lookupReleaseGroup returns the first-release-date', async () => {
    const url = 'https://musicbrainz.org/ws/2/release-group/rg-1?fmt=json';
    const { fetchImpl } = fakeFetch({
      [url]: { id: 'rg-1', title: 'Ghost Reveries', 'first-release-date': '2005-08-24' },
    });
    const mb = new MusicBrainzClient('test/1.0', { ...opts, fetchImpl });
    expect(await mb.lookupReleaseGroup('rg-1')).toEqual({ firstReleaseDate: '2005-08-24' });
  });

  it('lookupReleaseGroup handles a partial (year-only) release date', async () => {
    const url = 'https://musicbrainz.org/ws/2/release-group/rg-2?fmt=json';
    const { fetchImpl } = fakeFetch({
      [url]: { id: 'rg-2', title: 'Some Album', 'first-release-date': '1998' },
    });
    const mb = new MusicBrainzClient('test/1.0', { ...opts, fetchImpl });
    expect(await mb.lookupReleaseGroup('rg-2')).toEqual({ firstReleaseDate: '1998' });
  });

  it('lookupReleaseGroup returns null for an unknown release-group (404)', async () => {
    const { fetchImpl } = fakeFetch({});
    const mb = new MusicBrainzClient('test/1.0', { ...opts, fetchImpl });
    expect(await mb.lookupReleaseGroup('nope')).toBeNull();
  });
});
