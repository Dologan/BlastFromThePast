/**
 * Search-based deep links into the streaming services. Until precise
 * service-track/album/artist matching lands, a search URL reliably lands the
 * user on the right thing in the web/desktop app without needing any ID
 * resolution. Passing `kind` narrows the search to that result type instead
 * of a generic mixed search page, where the service's web player supports it.
 */

export type DeepLinkKind = 'track' | 'album' | 'artist';

const SEARCH_TYPE: Record<DeepLinkKind, string> = { track: 'tracks', album: 'albums', artist: 'artists' };

export function spotifySearchUrl(query: string, kind?: DeepLinkKind): string {
  const base = `https://open.spotify.com/search/${encodeURIComponent(query)}`;
  return kind ? `${base}/${SEARCH_TYPE[kind]}` : base;
}

export function tidalSearchUrl(query: string, kind?: DeepLinkKind): string {
  const path = kind ? `/search/${SEARCH_TYPE[kind]}` : '/search';
  return `https://tidal.com${path}?q=${encodeURIComponent(query)}`;
}

/** "Artist Name Title" — the query used for a result's deep links. */
export function searchQueryFor(row: { artistName: string; name: string }): string {
  return `${row.artistName} ${row.name}`.trim();
}
