import { describe, it, expect } from 'vitest';
import { spotifySearchUrl, tidalSearchUrl, searchQueryFor } from '../src/deeplinks.js';

describe('deep link search URLs', () => {
  it('builds a generic search URL when no kind is given', () => {
    expect(spotifySearchUrl('Opeth Harvest')).toBe('https://open.spotify.com/search/Opeth%20Harvest');
    expect(tidalSearchUrl('Opeth Harvest')).toBe('https://tidal.com/search?q=Opeth%20Harvest');
  });

  it('narrows to a result type when a kind is given', () => {
    expect(spotifySearchUrl('Opeth', 'artist')).toBe('https://open.spotify.com/search/Opeth/artists');
    expect(spotifySearchUrl('Ghost Reveries', 'album')).toBe('https://open.spotify.com/search/Ghost%20Reveries/albums');
    expect(spotifySearchUrl('Harvest', 'track')).toBe('https://open.spotify.com/search/Harvest/tracks');

    expect(tidalSearchUrl('Opeth', 'artist')).toBe('https://tidal.com/search/artists?q=Opeth');
    expect(tidalSearchUrl('Ghost Reveries', 'album')).toBe('https://tidal.com/search/albums?q=Ghost%20Reveries');
    expect(tidalSearchUrl('Harvest', 'track')).toBe('https://tidal.com/search/tracks?q=Harvest');
  });

  it('builds "artist title" queries', () => {
    expect(searchQueryFor({ artistName: 'Opeth', name: 'Harvest' })).toBe('Opeth Harvest');
  });
});
