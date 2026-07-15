# Blast From The Past

Rediscover music you used to love. BlastFromThePast mines your Last.fm listening
history (and liked tracks from streaming services) to pick albums and build
playlists on **TIDAL** and **Spotify** — e.g. *"progressive metal I first
listened to in 2010–2015 but haven't played in two years"*.

It keeps a persistent local cache (SQLite) of your scrobbles, so after the
one-time backfill, syncs are fast and incremental.

## Status

Phase 1 of 5 — foundation:

- [x] Monorepo scaffold (npm workspaces, TypeScript everywhere)
- [x] SQLite schema + migrations (scrobbles, entities, tags, stats, service links)
- [x] Last.fm sync engine: resumable full-history backfill, incremental updates,
      loved tracks, materialized listening stats (first/last listen, playcount,
      peak month per track/album/artist)
- [x] Fastify API + minimal web UI (connection setup, sync dashboard, library summary)
- [ ] Metadata enrichment: MusicBrainz country/genres, Last.fm tags, genre hierarchy
- [ ] Filter engine + saved "recipes" (date ranges, neglect, genre, country, …)
- [ ] Spotify & TIDAL connectors: OAuth, liked-tracks import, playlist push
- [ ] Presets, anniversaries, playlist history exclusions, mobile styling

## Running

Requires Node.js ≥ 20.

```sh
npm install
npm run build        # builds the web UI
npm start            # serves app + API on http://127.0.0.1:8765
```

For development (API on :8765, hot-reloading UI on :5173):

```sh
npm run dev          # server
npm run dev:web      # vite dev server, proxies /api
```

Then open the app, enter your Last.fm username and an
[API key](https://www.last.fm/api/account/create), and hit **Sync**. The first
sync fetches your entire scrobble history (a few minutes for large libraries —
it's resumable if interrupted); subsequent syncs only fetch what's new.

Data lives in `./data/library.db` (override with `BFTP_DB_PATH`). Port/host:
`BFTP_PORT`, `BFTP_HOST`.

## Layout

```
apps/server     Fastify API + sync jobs (runs via tsx, no build step)
apps/web        React + Vite SPA
packages/core   domain types, name normalization, service-connector interfaces
packages/db     SQLite schema, migrations, drizzle setup
```

## Tests

```sh
npm test
npm run typecheck
```
