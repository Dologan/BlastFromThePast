/**
 * Search-based deep links into the streaming services. Until precise
 * service-track matching lands (Phase 4), a search URL for "artist name"
 * reliably lands the user on the right thing in the web/desktop app without
 * needing any per-track ID resolution.
 */

export function spotifySearchUrl(query: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
}

export function tidalSearchUrl(query: string): string {
  return `https://tidal.com/search?q=${encodeURIComponent(query)}`;
}

/** "Artist Name Title" — the query used for a result's deep links. */
export function searchQueryFor(row: { artistName: string; name: string }): string {
  return `${row.artistName} ${row.name}`.trim();
}
