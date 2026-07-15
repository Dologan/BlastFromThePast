/**
 * Canonical form used for entity identity (artist/album/track names as they
 * arrive from Last.fm and, later, streaming services). Lowercased, trimmed,
 * whitespace collapsed, and common unicode punctuation variants folded so the
 * same song scrobbled from different sources maps to one row.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}
