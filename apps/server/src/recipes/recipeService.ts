import type { DbHandle } from '@bftp/db';
import {
  compileRecipe,
  GenreResolver,
  searchQueryFor,
  spotifySearchUrl,
  tidalSearchUrl,
  type GenreRule,
  type Recipe,
} from '@bftp/core';

export interface PreviewRow {
  entityId: number;
  entityKind: 'track' | 'album';
  name: string;
  artistName: string;
  albumName: string | null;
  playcount: number;
  firstListen: number;
  lastListen: number;
  spotifyUrl: string;
  tidalUrl: string;
}

export interface PreviewResult {
  matched: number;
  rows: PreviewRow[];
}

export interface SavedRecipe {
  id: number;
  name: string;
  definition: Recipe;
  createdAt: number;
  updatedAt: number;
}

/** Recipe compilation/execution and CRUD over the recipes table. */
export class RecipeService {
  constructor(private readonly handle: DbHandle) {}

  private resolver(): GenreResolver {
    const rules = this.handle.sqlite
      .prepare('SELECT pattern, genre, parent FROM genre_rules')
      .all() as GenreRule[];
    return new GenreResolver(rules);
  }

  private allTagNames(): string[] {
    return (this.handle.sqlite.prepare('SELECT name FROM tags').all() as { name: string }[]).map(
      (r) => r.name,
    );
  }

  preview(recipe: Recipe): PreviewResult {
    const resolver = this.resolver();
    const allTags = this.allTagNames();
    const compiled = compileRecipe(recipe, {
      nowSeconds: Math.floor(Date.now() / 1000),
      resolveGenreTags: (anyOf, mode) => {
        const set = new Set<string>();
        for (const g of anyOf) for (const t of resolver.tagsMatchingGenre(g, allTags, mode)) set.add(t);
        return [...set];
      },
    });

    const raw = this.handle.sqlite.prepare(compiled.sql).all(...(compiled.params as unknown[])) as {
      entity_id: number;
      entity_kind: 'track' | 'album';
      name: string;
      artist_name: string;
      album_name: string | null;
      playcount: number;
      first_listen: number;
      last_listen: number;
    }[];
    const matched = (
      this.handle.sqlite
        .prepare(compiled.countSql)
        .get(...(compiled.countParams as unknown[])) as { c: number }
    ).c;

    const rows: PreviewRow[] = raw.map((r) => {
      const query = searchQueryFor({ artistName: r.artist_name, name: r.name });
      return {
        entityId: r.entity_id,
        entityKind: r.entity_kind,
        name: r.name,
        artistName: r.artist_name,
        albumName: r.album_name,
        playcount: r.playcount,
        firstListen: r.first_listen,
        lastListen: r.last_listen,
        spotifyUrl: spotifySearchUrl(query, r.entity_kind),
        tidalUrl: tidalSearchUrl(query, r.entity_kind),
      };
    });
    return { matched, rows };
  }

  list(): SavedRecipe[] {
    const rows = this.handle.sqlite
      .prepare('SELECT id, name, definition, created_at, updated_at FROM recipes ORDER BY updated_at DESC')
      .all() as { id: number; name: string; definition: string; created_at: number; updated_at: number }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      definition: JSON.parse(r.definition) as Recipe,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  create(name: string, definition: Recipe): SavedRecipe {
    const now = Math.floor(Date.now() / 1000);
    const id = Number(
      this.handle.sqlite
        .prepare('INSERT INTO recipes (name, definition, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(name, JSON.stringify(definition), now, now).lastInsertRowid,
    );
    return { id, name, definition, createdAt: now, updatedAt: now };
  }

  update(id: number, name: string, definition: Recipe): boolean {
    const res = this.handle.sqlite
      .prepare('UPDATE recipes SET name = ?, definition = ?, updated_at = ? WHERE id = ?')
      .run(name, JSON.stringify(definition), Math.floor(Date.now() / 1000), id);
    return res.changes > 0;
  }

  remove(id: number): boolean {
    return this.handle.sqlite.prepare('DELETE FROM recipes WHERE id = ?').run(id).changes > 0;
  }

  /** Available filter values for the builder: countries in the library + known genres. */
  facets(): { countries: string[]; genres: string[] } {
    const countries = (
      this.handle.sqlite
        .prepare('SELECT DISTINCT country FROM artists WHERE country IS NOT NULL ORDER BY country')
        .all() as { country: string }[]
    ).map((r) => r.country);
    // Canonical genres from the rules, plus any raw tags that are actually
    // present, de-duplicated and sorted -- what a user can meaningfully pick.
    const ruleGenres = (
      this.handle.sqlite.prepare('SELECT DISTINCT genre FROM genre_rules ORDER BY genre').all() as {
        genre: string;
      }[]
    ).map((r) => r.genre);
    const genres = [...new Set(ruleGenres)];
    return { countries, genres };
  }
}
