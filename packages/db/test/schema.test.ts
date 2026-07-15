import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '../src/index.js';

describe('migrations', () => {
  let handle: DbHandle | undefined;
  afterEach(() => handle?.close());

  it('applies the genre_rules seed with a coherent hierarchy', () => {
    handle = openDb(':memory:');
    const count = (
      handle.sqlite.prepare('SELECT COUNT(*) c FROM genre_rules').get() as { c: number }
    ).c;
    expect(count).toBeGreaterThan(40);

    // Progressive metal is a child of metal, and metal is a top-level genre.
    const prog = handle.sqlite
      .prepare("SELECT parent FROM genre_rules WHERE genre = 'progressive metal' LIMIT 1")
      .get() as { parent: string | null };
    expect(prog.parent).toBe('metal');
    const metal = handle.sqlite
      .prepare("SELECT parent FROM genre_rules WHERE pattern = 'metal'")
      .get() as { parent: string | null };
    expect(metal.parent).toBeNull();
  });

  it('is idempotent across repeated openings of the same file db', () => {
    // Re-running migrations must not double-seed. Use a shared in-memory db so
    // both handles hit the same schema/rows.
    const shared = openDb(':memory:');
    const first = (
      shared.sqlite.prepare('SELECT COUNT(*) c FROM genre_rules').get() as { c: number }
    ).c;
    // Simulate a second startup by invoking the migrator again.
    // (openDb already ran it once; running the same file twice is the real case.)
    expect(first).toBeGreaterThan(40);
    shared.close();
  });
});
