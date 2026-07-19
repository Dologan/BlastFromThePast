import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { Classifier } from '../src/curate/classify.js';

function seedArtist(handle: DbHandle, name: string): number {
  return Number(
    handle.sqlite
      .prepare('INSERT INTO artists (name, name_normalized) VALUES (?, ?)')
      .run(name, name.toLowerCase()).lastInsertRowid,
  );
}

function tagArtist(handle: DbHandle, artistId: number, tag: string, weight: number): void {
  handle.sqlite.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tag);
  const tagId = (handle.sqlite.prepare('SELECT id FROM tags WHERE name = ?').get(tag) as { id: number }).id;
  handle.sqlite
    .prepare("INSERT INTO artist_tags (artist_id, tag_id, source, weight) VALUES (?, ?, 'lastfm', ?)")
    .run(artistId, tagId, weight);
}

describe('Classifier', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('classifies a "folk metal"-tagged artist into the metal family, not folk (hierarchy beats word-contains)', () => {
    handle = openDb(':memory:');
    const artist = seedArtist(handle, 'Eluveitie');
    tagArtist(handle, artist, 'folk metal', 10);

    const classifier = new Classifier(handle.sqlite);
    expect(classifier.family(artist)).toBe('metal');
  });

  it('canonicalGenre mode returns the canonical genre of the single top-weighted tag', () => {
    handle = openDb(':memory:');
    const artist = seedArtist(handle, 'Periphery');
    tagArtist(handle, artist, 'djent', 20);
    tagArtist(handle, artist, 'ambient', 3);

    const classifier = new Classifier(handle.sqlite);
    expect(classifier.canonicalGenre(artist)).toBe('djent');
    // family mode still resolves the broader root via djent's ancestor chain.
    expect(classifier.family(artist)).toBe('metal');
  });

  it('an artist with no tags is Unclassified (null) in both modes', () => {
    handle = openDb(':memory:');
    const artist = seedArtist(handle, 'No Tags');

    const classifier = new Classifier(handle.sqlite);
    expect(classifier.family(artist)).toBeNull();
    expect(classifier.canonicalGenre(artist)).toBeNull();
  });

  it('an artist whose tags match no root genre at all is Unclassified', () => {
    handle = openDb(':memory:');
    const artist = seedArtist(handle, 'Mystery Genre');
    tagArtist(handle, artist, 'seapunk', 5); // not in genre_rules, no word-contains match either

    const classifier = new Classifier(handle.sqlite);
    expect(classifier.family(artist)).toBeNull();
  });

  it('memoizes per instance -- repeated calls for the same artist do not re-run the query', () => {
    handle = openDb(':memory:');
    const artist = seedArtist(handle, 'Opeth');
    tagArtist(handle, artist, 'progressive metal', 10);
    const classifier = new Classifier(handle.sqlite);
    expect(classifier.family(artist)).toBe('metal');
    // Mutate the underlying tags after the first call; a memoized result should not change.
    handle.sqlite.prepare('DELETE FROM artist_tags WHERE artist_id = ?').run(artist);
    expect(classifier.family(artist)).toBe('metal');
  });
});
