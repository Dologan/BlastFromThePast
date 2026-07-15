import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';
import { rebuildStats } from '../src/sync/stats.js';
import type { FastifyInstance } from 'fastify';

const NOW = Math.floor(Date.now() / 1000);
const YEAR = 365 * 86400;

describe('recipe API', () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeEach(async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    const metalTag = Number(s.prepare("INSERT INTO tags (name) VALUES ('progressive metal')").run().lastInsertRowid);
    const popTag = Number(s.prepare("INSERT INTO tags (name) VALUES ('pop')").run().lastInsertRowid);

    const opeth = Number(s.prepare("INSERT INTO artists (name, name_normalized, country) VALUES ('Opeth','opeth','SE')").run().lastInsertRowid);
    const bg = Number(s.prepare("INSERT INTO artists (name, name_normalized, country) VALUES ('Boygenius','boygenius','US')").run().lastInsertRowid);
    s.prepare("INSERT INTO artist_tags (artist_id, tag_id, source, weight) VALUES (?, ?, 'musicbrainz', 10)").run(opeth, metalTag);
    s.prepare("INSERT INTO artist_tags (artist_id, tag_id, source, weight) VALUES (?, ?, 'musicbrainz', 10)").run(bg, popTag);

    const ot = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Ghost of Perdition','ghost of perdition')").run(opeth).lastInsertRowid);
    const bt = Number(s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Not Strong Enough','not strong enough')").run(bg).lastInsertRowid);
    // Opeth played heavily 5y ago; Boygenius recently.
    for (const uts of [NOW - 5 * YEAR, NOW - 5 * YEAR + 86400, NOW - 5 * YEAR + 2 * 86400]) {
      s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(ot, uts);
    }
    s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(bt, NOW - 10 * 86400);
    rebuildStats(s);

    app = buildApp({ handle });
  });

  afterEach(async () => {
    await app.close();
    handle.close();
  });

  it('exposes facets (countries present + known genres)', async () => {
    const facets = (await app.inject({ method: 'GET', url: '/api/facets' })).json();
    expect(facets.countries).toEqual(['SE', 'US']);
    expect(facets.genres).toContain('metal');
    expect(facets.genres).toContain('progressive metal');
  });

  it('previews a recipe: matched count + rows with deep links', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/recipes/preview',
      payload: {
        filters: [
          { type: 'genre', anyOf: ['metal'] },
          { type: 'notPlayedInDays', days: 3 * 365 },
        ],
        output: { mode: 'tracks', sort: 'neglect', limit: 10 },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matched).toBe(1);
    expect(body.rows[0].artistName).toBe('Opeth');
    expect(body.rows[0].spotifyUrl).toContain('open.spotify.com/search/');
    expect(body.rows[0].tidalUrl).toContain('tidal.com/search');
  });

  it('rejects a malformed recipe', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/recipes/preview', payload: { nope: true } });
    expect(res.statusCode).toBe(400);
  });

  it('supports full recipe CRUD', async () => {
    const definition = { filters: [{ type: 'genre', anyOf: ['metal'] }], output: { mode: 'albums', sort: 'neglect', limit: 20 } };

    const created = await app.inject({ method: 'POST', url: '/api/recipes', payload: { name: 'Forgotten metal', definition } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const list1 = (await app.inject({ method: 'GET', url: '/api/recipes' })).json();
    expect(list1).toHaveLength(1);
    expect(list1[0].definition.filters[0].anyOf).toEqual(['metal']);

    const upd = await app.inject({ method: 'PUT', url: `/api/recipes/${id}`, payload: { name: 'Renamed', definition } });
    expect(upd.statusCode).toBe(204);
    const list2 = (await app.inject({ method: 'GET', url: '/api/recipes' })).json();
    expect(list2[0].name).toBe('Renamed');

    const del = await app.inject({ method: 'DELETE', url: `/api/recipes/${id}` });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/recipes' })).json()).toHaveLength(0);

    expect((await app.inject({ method: 'DELETE', url: `/api/recipes/${id}` })).statusCode).toBe(404);
  });
});
