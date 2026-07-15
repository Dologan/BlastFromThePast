export interface GenreRule {
  pattern: string;
  genre: string;
  parent: string | null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolves raw folksonomy tags to canonical genres and answers hierarchy
 * questions, driven by the seeded (and user-editable) `genre_rules` table.
 *
 * A tag matches a target genre T if any of:
 *   1. its canonical genre == T,
 *   2. T is an ancestor of its canonical genre (progressive metal -> metal),
 *   3. T appears as a whole word inside the tag (the fallback that makes
 *      "<x> metal" match "metal" without needing a rule per subgenre).
 *
 * All comparisons are case-insensitive. Pure and DB-free so it's unit-testable
 * and can run either server-side (compiling a query) or in tests.
 */
export class GenreResolver {
  private readonly rules: { matcher: (v: string) => boolean; genre: string }[];
  private readonly parentOf = new Map<string, string>();

  constructor(rules: GenreRule[]) {
    this.rules = rules.map((r) => ({ matcher: patternMatcher(r.pattern), genre: r.genre.toLowerCase() }));
    for (const r of rules) {
      const genre = r.genre.toLowerCase();
      if (r.parent && !this.parentOf.has(genre)) this.parentOf.set(genre, r.parent.toLowerCase());
    }
  }

  /** The canonical genre for a tag: first matching rule's genre, else the tag itself. */
  canonical(tag: string): string {
    const t = tag.toLowerCase().trim();
    for (const rule of this.rules) if (rule.matcher(t)) return rule.genre;
    return t;
  }

  /** Ancestor genres of a canonical genre, nearest first, cycle-guarded. */
  ancestors(genre: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    let current = this.parentOf.get(genre.toLowerCase());
    while (current && !seen.has(current)) {
      seen.add(current);
      out.push(current);
      current = this.parentOf.get(current);
    }
    return out;
  }

  private wordContains(tag: string, target: string): boolean {
    return new RegExp(`\\b${escapeRegex(target)}\\b`).test(tag);
  }

  matchesTag(tag: string, target: string): boolean {
    const t = target.toLowerCase().trim();
    const tagLower = tag.toLowerCase().trim();
    const canon = this.canonical(tagLower);
    if (canon === t) return true;
    if (this.ancestors(canon).includes(t)) return true;
    return this.wordContains(tagLower, t);
  }

  /**
   * From a universe of tag names, those matching the target genre.
   * `canonical` mode uses the hierarchy/word rules above; `raw` mode matches
   * the target literally (supporting a trailing/leading '*' wildcard), for
   * power users who want an exact folksonomy tag rather than a genre family.
   */
  tagsMatchingGenre(target: string, allTags: string[], mode: 'canonical' | 'raw' = 'canonical'): string[] {
    if (mode === 'raw') {
      const m = patternMatcher(target);
      return allTags.filter((tag) => m(tag.toLowerCase().trim()));
    }
    return allTags.filter((tag) => this.matchesTag(tag, target));
  }
}

/** Builds a predicate for a genre_rule pattern; '*' is a wildcard, else exact. */
function patternMatcher(pattern: string): (value: string) => boolean {
  const p = pattern.toLowerCase().trim();
  if (p.includes('*')) {
    const rx = new RegExp('^' + p.split('*').map(escapeRegex).join('.*') + '$');
    return (value) => rx.test(value);
  }
  return (value) => value === p;
}
