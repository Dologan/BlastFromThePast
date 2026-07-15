# Blast From The Past

Rediscover music you used to love. BlastFromThePast mines your Last.fm listening
history (and liked tracks from streaming services) to pick albums and build
playlists on **TIDAL** and **Spotify** — e.g. *"progressive metal I first
listened to in 2010–2015 but haven't played in two years"*.

It keeps a persistent local cache (SQLite) of your scrobbles, so after the
one-time backfill, syncs are fast and incremental.

## Status

Phase 3 of 5 complete:

- [x] Monorepo scaffold (npm workspaces, TypeScript everywhere)
- [x] SQLite schema + migrations (scrobbles, entities, tags, stats, service links)
- [x] Last.fm sync engine: resumable full-history backfill, incremental updates,
      loved tracks, materialized listening stats (first/last listen, playcount,
      peak month per track/album/artist)
- [x] Fastify API + web UI (connection setup, sync dashboard, library summary)
- [x] Metadata enrichment: MusicBrainz country + genres, Last.fm artist tags,
      seeded genre hierarchy (`genre_rules`), resumable per-artist enrichment
      job, genre/country stats in the UI
- [x] Enrichment raw-response cache + parallel fetch: MusicBrainz/Last.fm
      responses are cached independently of the normalized schema, so a
      "Reprocess from cache" pass can rebuild `artists`/`artist_tags` after a
      schema or genre-mapping change with zero network calls; the two
      services are fetched on concurrent lanes since they rate-limit
      independently
- [x] Filter engine + saved "recipes": a JSON filter AST compiled to SQL
      over the materialized stats — date ranges (first/last/peak listen),
      "haven't played in N days", play-count ranges, genre (with subgenre
      hierarchy), country, loved/liked, playlist-history exclusion; output
      shaping (albums/tracks, neglect/recency/weighted-shuffle sorts, limit,
      per-artist diversity cap); recipe builder UI with live preview and
      Spotify/TIDAL deep links
- [ ] Spotify & TIDAL connectors: OAuth, liked-tracks import, precise
      playlist push (upgrading the search deep links to exact matches)
- [ ] Presets, anniversaries, mobile styling

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

Then hit **Enrich artists** to fetch country of origin and genre tags from
MusicBrainz + Last.fm. MusicBrainz is rate-limited to ~1 request/second (the
two services are fetched concurrently, so Last.fm's faster limit doesn't add
to the total), so a large library still takes a while the first time — it's
resumable, and every response is cached permanently and keyed independently
of the normalized schema. If you (or a future update) change how that cached
data is mapped into `artists`/`artist_tags`, use **Reprocess from cache** to
rebuild the normalized tables instantly, with no network calls at all.

Data lives in `./data/library.db` (override with `BFTP_DB_PATH`). Port/host:
`BFTP_PORT`, `BFTP_HOST`.

## Layout

```
apps/server     Fastify API + sync/enrich jobs + recipe service (tsx, no build step)
apps/web        React + Vite SPA (dashboard + recipe builder)
packages/core   domain types, name normalization, connector interfaces,
                recipe AST, genre resolver, recipe→SQL compiler, deep links
packages/db     SQLite schema, migrations, drizzle setup, custom SQL functions
```

## How recipes work

A **recipe** is a saved JSON filter definition plus output shaping. The
`packages/core` compiler turns it into a single parameterized SQL query over
the materialized per-track/album/artist stats, so previews are instant even on
a large library. Genre filtering understands a hierarchy — asking for `metal`
also matches `progressive metal`, `djent`, etc. via the seeded (user-editable)
`genre_rules` table plus a whole-word fallback. Results link straight out to
Spotify/TIDAL search; Phase 4 upgrades those to exact track matches.

## Tests

```sh
npm test
npm run typecheck
```
