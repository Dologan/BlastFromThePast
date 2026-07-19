import type Database from 'better-sqlite3';
import { GenreResolver, type GenreRule } from '@bftp/core';

export type GroupBy = 'genreFamily' | 'canonicalGenre';

interface ArtistTagRow {
  tag: string;
  weight: number;
}

/**
 * Classifies artists into a broad genre "family" (a root of the genre_rules
 * hierarchy, e.g. "metal" -- covering "progressive metal", "djent", etc.) or,
 * in the finer-grained mode, the canonical genre of their single top-weighted
 * tag. Built on the same GenreResolver used for recipe genre filtering, so
 * classification stays consistent with how genre filters already match.
 */
export class Classifier {
  private readonly resolver: GenreResolver;
  private readonly roots: string[];
  private readonly familyCache = new Map<number, string | null>();
  private readonly canonicalCache = new Map<number, string | null>();
  private readonly tagsStmt: Database.Statement;

  constructor(sqlite: Database.Database) {
    const rules = sqlite.prepare('SELECT pattern, genre, parent FROM genre_rules').all() as GenreRule[];
    this.resolver = new GenreResolver(rules);
    this.roots = [...new Set(rules.filter((r) => !r.parent).map((r) => r.genre.toLowerCase()))].sort();
    this.tagsStmt = sqlite.prepare(
      `SELECT t.name AS tag, at.weight AS weight FROM artist_tags at JOIN tags t ON t.id = at.tag_id WHERE at.artist_id = ?`,
    );
  }

  private tagsFor(artistId: number): ArtistTagRow[] {
    return this.tagsStmt.all(artistId) as ArtistTagRow[];
  }

  /** Dominant root genre family, or null (Unclassified) if the artist has no tags or no root match. */
  family(artistId: number): string | null {
    const cached = this.familyCache.get(artistId);
    if (cached !== undefined) return cached;
    const tags = this.tagsFor(artistId);
    const scores = new Map<string, number>();
    for (const { tag, weight } of tags) {
      const canon = this.resolver.canonical(tag);
      const ancestors = this.resolver.ancestors(canon);
      for (const root of this.roots) {
        if (canon === root || ancestors.includes(root)) {
          scores.set(root, (scores.get(root) ?? 0) + weight * 2);
        } else if (this.resolver.matchesTag(tag, root)) {
          scores.set(root, (scores.get(root) ?? 0) + weight);
        }
      }
    }
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const root of [...scores.keys()].sort()) {
      const score = scores.get(root)!;
      if (score > bestScore) {
        bestScore = score;
        best = root;
      }
    }
    this.familyCache.set(artistId, best);
    return best;
  }

  /** Canonical genre of the artist's single top-weighted tag (ties broken alphabetically). */
  canonicalGenre(artistId: number): string | null {
    const cached = this.canonicalCache.get(artistId);
    if (cached !== undefined) return cached;
    const tags = this.tagsFor(artistId);
    let top: ArtistTagRow | null = null;
    for (const t of tags) {
      if (!top || t.weight > top.weight || (t.weight === top.weight && t.tag < top.tag)) top = t;
    }
    const result = top ? this.resolver.canonical(top.tag) : null;
    this.canonicalCache.set(artistId, result);
    return result;
  }

  classify(artistId: number, groupBy: GroupBy): string | null {
    return groupBy === 'canonicalGenre' ? this.canonicalGenre(artistId) : this.family(artistId);
  }
}
