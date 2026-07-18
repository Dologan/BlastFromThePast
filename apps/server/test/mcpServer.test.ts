import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { rebuildStats } from '../src/sync/stats.js';
import { setSetting, SETTING_KEYS } from '../src/settings.js';
import { callTool, TOOLS, type McpConfig } from '../src/mcp/server.js';
import type { AuthManager } from '../src/auth/authManager.js';
import type { ServiceConnector, ServiceTrack, TrackQuery } from '@bftp/core';

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

/** The canonical NL example: "metal I haven't played in 5 years with more than 10 plays". */
const CANONICAL_RECIPE = {
  filters: [
    { type: 'genre', anyOf: ['metal'] },
    { type: 'notPlayedInDays', days: 1825 },
    { type: 'playcount', min: 10 },
  ],
  output: { mode: 'tracks', sort: 'weighted_random', limit: 50 },
};

class FakeConnector implements ServiceConnector {
  readonly service = 'spotify' as const;
  createCalls = 0;
  async isAuthorized() {
    return true;
  }
  async searchTrack(q: TrackQuery): Promise<ServiceTrack[]> {
    return [{ serviceId: `sp-${q.trackName.toLowerCase().replace(/\s+/g, '-')}`, name: q.trackName, artistName: q.artistName }];
  }
  async createPlaylist() {
    this.createCalls++;
    return 'PL42';
  }
  async setPlaylistTracks() {}
  async getPlaylistTrackIds(): Promise<string[]> {
    return [];
  }
  deepLinkTrack(id: string) {
    return `https://open.spotify.com/track/${id}`;
  }
  deepLinkAlbum(id: string) {
    return `https://open.spotify.com/album/${id}`;
  }
  deepLinkArtist(id: string) {
    return `https://open.spotify.com/artist/${id}`;
  }
  deepLinkPlaylist(id: string) {
    return `https://open.spotify.com/playlist/${id}`;
  }
}

describe('MCP server tools (against a live API instance)', () => {
  let handle: DbHandle;
  let app: FastifyInstance;
  let cfg: McpConfig;
  const connector = new FakeConnector();

  beforeAll(async () => {
    handle = openDb(':memory:');
    const s = handle.sqlite;
    // "Forgotten Metal": tagged metal, 11 plays, all ~6 years ago — matches the canonical recipe.
    const opeth = Number(s.prepare("INSERT INTO artists (name, name_normalized, country) VALUES ('Opeth','opeth','SE')").run().lastInsertRowid);
    const tag = Number(s.prepare("INSERT INTO tags (name) VALUES ('metal')").run().lastInsertRowid);
    s.prepare("INSERT INTO artist_tags (artist_id, tag_id, source, weight) VALUES (?, ?, 'musicbrainz', 10)").run(opeth, tag);
    const t = Number(
      s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Ghost of Perdition','ghost of perdition')").run(opeth).lastInsertRowid,
    );
    for (let i = 0; i < 11; i++) s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(t, NOW - 6 * 365 * DAY + i * DAY);
    // A recent pop track that must NOT match.
    const pop = Number(s.prepare("INSERT INTO artists (name, name_normalized) VALUES ('Boygenius','boygenius')").run().lastInsertRowid);
    const p = Number(
      s.prepare("INSERT INTO tracks (artist_id, name, name_normalized) VALUES (?, 'Not Strong Enough','not strong enough')").run(pop).lastInsertRowid,
    );
    s.prepare('INSERT INTO scrobbles (track_id, uts) VALUES (?, ?)').run(p, NOW - 5 * DAY);
    rebuildStats(s);
    setSetting(handle, SETTING_KEYS.defaultService, 'spotify');

    app = buildApp({
      handle,
      authManager: { isAuthorized: () => true } as unknown as AuthManager,
      createConnector: () => connector,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    cfg = { baseUrl: `http://127.0.0.1:${addr.port}` };
  });

  afterAll(async () => {
    await app.close();
    handle.close();
  });

  it('exposes the four tools, all with input schemas', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['get_context', 'preview_playlist', 'check_existing_playlist', 'create_playlist']);
    for (const t of TOOLS) expect(t.inputSchema.type).toBe('object');
  });

  it('get_context grounds genres, countries, default service and connections', async () => {
    const ctx = JSON.parse(await callTool(cfg, 'get_context', {}));
    expect(ctx.genres).toContain('metal');
    expect(ctx.countries).toContain('SE');
    expect(ctx.defaultService).toBe('spotify');
    expect(ctx.connected).toEqual({ spotify: true, tidal: true });
  });

  it('preview_playlist runs the canonical example and returns count + sample', async () => {
    const preview = JSON.parse(await callTool(cfg, 'preview_playlist', { recipe: CANONICAL_RECIPE }));
    expect(preview.matched).toBe(1);
    expect(preview.sample).toEqual(['Ghost of Perdition — Opeth']);
  });

  it('create_playlist publishes via the default service and reports the URL', async () => {
    const result = JSON.parse(
      await callTool(cfg, 'create_playlist', { recipe: CANONICAL_RECIPE, name: 'Forgotten Metal' }),
    );
    expect(result.playlistUrl).toBe('https://open.spotify.com/playlist/PL42');
    expect(result.service).toBe('spotify');
    expect(result.matchedCount).toBe(1);
    expect(result.unmatchedCount).toBe(0);
  });

  it('check_existing_playlist finds the playlist just pushed', async () => {
    const data = JSON.parse(await callTool(cfg, 'check_existing_playlist', { service: 'spotify', name: 'Forgotten Metal' }));
    expect(data.existing.playlistId).toBe('PL42');
  });

  it('create_playlist in append mode auto-resolves the existing playlist instead of creating a new one', async () => {
    const before = connector.createCalls;
    const result = JSON.parse(
      await callTool(cfg, 'create_playlist', { recipe: CANONICAL_RECIPE, name: 'Forgotten Metal', mode: 'append' }),
    );
    expect(connector.createCalls).toBe(before); // reused, not re-created
    expect(result.playlistUrl).toBe('https://open.spotify.com/playlist/PL42');
  });

  it('create_playlist fails with guidance when no service is given and none is configured', async () => {
    setSetting(handle, SETTING_KEYS.defaultService, '');
    await expect(callTool(cfg, 'create_playlist', { recipe: CANONICAL_RECIPE, name: 'X' })).rejects.toThrow(/spotify or tidal/);
    setSetting(handle, SETTING_KEYS.defaultService, 'spotify');
  });

  it('sends the bearer token when configured', async () => {
    let captured: Record<string, string> | undefined;
    const spyCfg: McpConfig = {
      ...cfg,
      token: 'sekrit',
      fetchImpl: ((url: any, init: any) => {
        captured = init?.headers;
        return fetch(url, init);
      }) as typeof fetch,
    };
    await callTool(spyCfg, 'get_context', {});
    expect(captured?.Authorization).toBe('Bearer sekrit');
  });
});
