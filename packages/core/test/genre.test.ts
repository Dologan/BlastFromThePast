import { describe, it, expect } from 'vitest';
import { GenreResolver, type GenreRule } from '../src/genre.js';

// A small slice of the real seed, enough to exercise every matching path.
const RULES: GenreRule[] = [
  { pattern: 'metal', genre: 'metal', parent: null },
  { pattern: 'rock', genre: 'rock', parent: null },
  { pattern: 'progressive metal', genre: 'progressive metal', parent: 'metal' },
  { pattern: 'death metal', genre: 'death metal', parent: 'metal' },
  { pattern: 'djent', genre: 'djent', parent: 'progressive metal' },
  { pattern: 'grindcore', genre: 'grindcore', parent: 'metal' },
  { pattern: 'prog metal', genre: 'progressive metal', parent: 'metal' },
  { pattern: 'post-rock', genre: 'post-rock', parent: 'rock' },
];

describe('GenreResolver', () => {
  const r = new GenreResolver(RULES);

  it('resolves canonical genres, applying aliases', () => {
    expect(r.canonical('Progressive Metal')).toBe('progressive metal');
    expect(r.canonical('prog metal')).toBe('progressive metal'); // alias
    expect(r.canonical('shoegaze')).toBe('shoegaze'); // no rule -> itself
  });

  it('walks the ancestor chain', () => {
    expect(r.ancestors('djent')).toEqual(['progressive metal', 'metal']);
    expect(r.ancestors('metal')).toEqual([]);
  });

  it('matches subgenres to a parent genre via hierarchy', () => {
    expect(r.matchesTag('progressive metal', 'metal')).toBe(true);
    expect(r.matchesTag('djent', 'metal')).toBe(true); // two levels up
    expect(r.matchesTag('grindcore', 'metal')).toBe(true); // non-substring subgenre
  });

  it('matches via the whole-word fallback without a rule', () => {
    // "swedish death metal" has no rule but word-contains "metal".
    expect(r.matchesTag('swedish death metal', 'metal')).toBe(true);
    // Guard against substring false positives.
    expect(r.matchesTag('rockabilly', 'rock')).toBe(false);
  });

  it('does not match across unrelated families', () => {
    expect(r.matchesTag('post-rock', 'metal')).toBe(false);
    expect(r.matchesTag('death metal', 'rock')).toBe(false);
  });

  it('tagsMatchingGenre gathers a genre family from the tag universe', () => {
    const universe = ['progressive metal', 'death metal', 'djent', 'post-rock', 'jazz', 'metal'];
    expect(r.tagsMatchingGenre('metal', universe).sort()).toEqual(
      ['death metal', 'djent', 'metal', 'progressive metal'].sort(),
    );
  });

  it('raw mode matches literally, with wildcard support', () => {
    const universe = ['progressive metal', 'nu metal', 'metalcore', 'jazz'];
    expect(r.tagsMatchingGenre('nu metal', universe, 'raw')).toEqual(['nu metal']);
    expect(r.tagsMatchingGenre('*metal', universe, 'raw').sort()).toEqual(
      ['nu metal', 'progressive metal'].sort(),
    );
  });
});
