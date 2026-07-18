/**
 * MCP (Model Context Protocol) server exposing BlastFromThePast's playlist
 * engine to assistant LLMs — OpenClaw (via mcporter), Claude Desktop, or any
 * MCP client. The assistant's own model translates natural language ("metal I
 * haven't played in 5 years with more than 10 plays") into the Recipe JSON
 * these tools accept; the schemas' descriptions carry the semantics it needs.
 *
 * Deliberately a thin proxy over the running HTTP API (BFTP_API_URL) rather
 * than a second DB client: OAuth tokens, job serialization and push logic all
 * stay in the one server process, and this works identically whether the
 * assistant runs on the same host or across the network (BFTP_API_TOKEN).
 *
 * Run: `npm run mcp` (stdio transport).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { RECIPE_JSON_SCHEMA, type Recipe, type ServiceName } from '@bftp/core';

export interface McpConfig {
  /** Base URL of the running BlastFromThePast server. */
  baseUrl: string;
  /** Bearer token, required only when the API is reached over the network with auth enabled. */
  token?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export function configFromEnv(): McpConfig {
  return {
    baseUrl: process.env.BFTP_API_URL ?? 'http://127.0.0.1:8765',
    token: process.env.BFTP_API_TOKEN || undefined,
  };
}

async function api(cfg: McpConfig, method: string, path: string, body?: unknown): Promise<any> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(data?.error ?? `BlastFromThePast API: HTTP ${res.status} for ${method} ${path}`);
  return data;
}

const SERVICE_SCHEMA = {
  enum: ['spotify', 'tidal'],
  description: 'Streaming service to publish to. Omit to use the configured default service.',
};

export const TOOLS = [
  {
    name: 'get_context',
    description:
      "Library context for grounding a request: canonical genre names that exist in the user's library, " +
      'country codes present, which streaming services are connected, and the configured default service. ' +
      'Call this before building a recipe when unsure a genre/country the user named exists.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'preview_playlist',
    description:
      'Dry-run a recipe: returns how many tracks/albums match plus a small sample, WITHOUT creating anything. ' +
      'Always preview before create_playlist and confirm with the user (e.g. "42 tracks matched — create it?"). ' +
      'If the match count is 0 or huge, adjust the filters and preview again.',
    inputSchema: {
      type: 'object',
      properties: { recipe: RECIPE_JSON_SCHEMA },
      required: ['recipe'],
    },
  },
  {
    name: 'check_existing_playlist',
    description:
      'Whether a playlist with this name was already pushed to this service. If one exists, ask the user whether ' +
      "to replace its contents, append to it, or create a new playlist anyway — then pass create_playlist's mode accordingly.",
    inputSchema: {
      type: 'object',
      properties: {
        service: { enum: ['spotify', 'tidal'] },
        name: { type: 'string', description: 'Playlist name to check.' },
      },
      required: ['service', 'name'],
    },
  },
  {
    name: 'create_playlist',
    description:
      'Compile the recipe, match the tracks on the streaming service, and publish the playlist. Returns the playlist ' +
      'URL and match stats. Preview first (preview_playlist) and get user confirmation before calling this. ' +
      "mode: 'new' always creates a fresh playlist; 'replace' overwrites and 'append' adds to the existing same-named " +
      'playlist (found automatically, or pass existingPlaylistId).',
    inputSchema: {
      type: 'object',
      properties: {
        recipe: RECIPE_JSON_SCHEMA,
        name: { type: 'string', description: 'Playlist name.' },
        service: SERVICE_SCHEMA,
        mode: { enum: ['new', 'replace', 'append'], description: "Default 'new'." },
        existingPlaylistId: { type: 'string', description: 'Target playlist for replace/append; auto-resolved from the name if omitted.' },
      },
      required: ['recipe', 'name'],
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];

interface CreatePlaylistArgs {
  recipe: Recipe;
  name: string;
  service?: ServiceName;
  mode?: 'new' | 'replace' | 'append';
  existingPlaylistId?: string;
}

export async function callTool(cfg: McpConfig, name: string, args: any): Promise<string> {
  switch (name as ToolName) {
    case 'get_context': {
      const [facets, settings, authStatus] = await Promise.all([
        api(cfg, 'GET', '/api/facets'),
        api(cfg, 'GET', '/api/settings'),
        api(cfg, 'GET', '/api/auth/status'),
      ]);
      return JSON.stringify({
        genres: facets.genres,
        countries: facets.countries,
        defaultService: settings.defaultService,
        connected: { spotify: authStatus.spotify.connected, tidal: authStatus.tidal.connected },
      });
    }
    case 'preview_playlist': {
      const preview = await api(cfg, 'POST', '/api/recipes/preview', args.recipe);
      const sample = preview.rows
        .slice(0, 15)
        .map((r: { name: string; artistName: string }) => `${r.name} — ${r.artistName}`);
      return JSON.stringify({ matched: preview.matched, sample });
    }
    case 'check_existing_playlist': {
      const data = await api(
        cfg,
        'GET',
        `/api/push/existing?service=${encodeURIComponent(args.service)}&name=${encodeURIComponent(args.name)}`,
      );
      return JSON.stringify(data);
    }
    case 'create_playlist': {
      const { recipe, name: playlistName, mode = 'new' } = args as CreatePlaylistArgs;
      let { service, existingPlaylistId } = args as CreatePlaylistArgs;
      if (!service) {
        const settings = await api(cfg, 'GET', '/api/settings');
        service = settings.defaultService ?? undefined;
        if (!service) {
          throw new Error(
            'No service given and no default service configured. Ask the user whether to publish to spotify or tidal.',
          );
        }
      }
      if (mode !== 'new' && !existingPlaylistId) {
        const existing = await api(
          cfg,
          'GET',
          `/api/push/existing?service=${encodeURIComponent(service)}&name=${encodeURIComponent(playlistName)}`,
        );
        if (!existing.existing) {
          throw new Error(`No existing playlist named "${playlistName}" on ${service} — use mode 'new' instead.`);
        }
        existingPlaylistId = existing.existing.playlistId;
      }
      const data = await api(cfg, 'POST', '/api/push/sync', {
        recipe,
        service,
        name: playlistName,
        mode,
        existingPlaylistId,
      });
      if (data.pending) {
        return JSON.stringify({
          pending: true,
          note: `The push is still running for ${data.trackCount} tracks; the playlist will appear on ${service} shortly.`,
        });
      }
      const r = data.result;
      return JSON.stringify({
        playlistUrl: r.playlistUrl,
        service: r.service,
        matchedCount: r.matchedCount,
        unmatchedCount: r.unmatched.length,
        unmatchedSample: r.unmatched.slice(0, 5).map((u: { name: string; artistName: string }) => `${u.name} — ${u.artistName}`),
        ...(r.skippedDuplicates ? { skippedDuplicates: r.skippedDuplicates } : {}),
        ...(r.itemsError ? { itemsError: r.itemsError } : {}),
        ...(r.matchError ? { matchError: r.matchError } : {}),
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createMcpServer(cfg: McpConfig): Server {
  const server = new Server(
    { name: 'blastfromthepast', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as unknown as any[] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const text = await callTool(cfg, req.params.name, req.params.arguments ?? {});
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cfg = configFromEnv();
  // stdout carries the MCP protocol; diagnostics go to stderr only.
  console.error(`BlastFromThePast MCP server (stdio) → ${cfg.baseUrl}`);
  void createMcpServer(cfg).connect(new StdioServerTransport());
}
