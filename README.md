# Blast From The Past

Rediscover music you used to love. BlastFromThePast mines your Last.fm listening
history (and liked tracks from streaming services) to pick albums and build
playlists on **TIDAL** and **Spotify** — e.g. *"progressive metal I first
listened to in 2010–2015 but haven't played in two years"*.

It keeps a persistent local cache (SQLite) of your scrobbles, so after the
one-time backfill, syncs are fast and incremental.

## Status

All five build phases complete:

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
      over the materialized stats — date ranges (first/last/peak listen,
      album release date), "haven't played in N days", play-count ranges,
      genre (with subgenre hierarchy), country, loved/liked, playlist-history
      exclusion; output shaping (albums/tracks, neglect/recency/weighted-shuffle
      sorts, limit, per-artist diversity cap); recipe builder UI with live
      preview and Spotify/TIDAL deep links
- [x] Album release-date enrichment: a second, MusicBrainz-only enrichment
      lane (same cache-then-derive pattern as artist enrichment) fills in
      each album's release date from its release-group, powering the
      `releaseDate` recipe filter above. Dates are often year-only precision
      from MusicBrainz, so the filter compares by year.
- [x] Spotify & TIDAL connectors: OAuth 2.0 + PKCE with encrypted token
      storage, Spotify liked-tracks import, service matching (ISRC → search,
      cached in `service_links`), and playlist push with matched/unmatched
      reporting. Connections + push UI wired in.
- [x] Polish: built-in preset recipes, an "on this day" anniversary filter,
      a match fix-up UI (search + manual override for imperfect matches), and
      responsive styling for phone use.
- [x] Curator tab: bulk-classifies loved/liked tracks and albums into
      playlists by genre family, with a live preview (counts, samples,
      per-group/per-track selection) before anything is pushed; a playlist-
      inventory sync so it knows what's already playlisted on Spotify/TIDAL;
      and a bulk "unlike" cleanup tool with a per-track protect flag. See
      [Curator](#curator) below.

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
`BFTP_PORT`, `BFTP_HOST`. OAuth redirect URIs are derived from `BFTP_PUBLIC_URL`
(defaults to `http://<host>:<port>`).

### Connecting Spotify / TIDAL

On the Dashboard, under **Streaming services**, paste a client ID from a
developer app you create on each service, then click **Connect** (OAuth 2.0 +
PKCE — no client secret needed). Register this redirect URI on the developer
app: `http://127.0.0.1:8765/api/auth/<service>/callback`. Tokens are stored
encrypted (AES-256-GCM) under `data/secret.key`.

Notes:
- **Spotify** development mode needs your own Premium account and allows a
  handful of users — fine for personal use.
- **TIDAL** liked tracks: via the `userCollectionTracks` API resource, TIDAL
  now supports reading and removing your liked tracks (used for TIDAL liked-
  track import and Curator's bulk unlike) — but not yet *adding* new ones, so
  "loving" a track only works on Spotify/Last.fm. TIDAL's write API is
  comparatively new; the endpoint shapes in
  `apps/server/src/connectors/tidal.ts` and `auth/serviceConfig.ts` are
  centralized in case they need adjustment against the live API.
- If you connected Spotify or TIDAL **before** the Curator feature, reconnect
  once (Disconnect, then Connect again) so the new library-modify / collection-
  write scopes are granted — otherwise bulk unlike will fail for that service.

Then in the **Recipe builder**, a tracks-mode recipe can be pushed straight to
a new playlist on either connected service; unmatched and low-confidence
tracks are listed with a **fix-up** control to search and pick the right match
manually (remembered as a verified link). Start from a **preset** (Forgotten
favourites, On this day, Deep cuts of a genre, Long-lost loves, Album
rediscovery) and tweak from there.

## Deploying on a VPS behind Tailscale

See [`deploy/DEPLOY.md`](deploy/DEPLOY.md) for a full walkthrough of running
this as a systemd service with two access paths: a gate-free copy reachable
only from your Tailnet, and a password-gated copy reachable from the public
internet (via Tailscale Funnel, or your own domain + Caddy).

## Layout

```
apps/server     Fastify API + sync/enrich jobs + recipe/curate/unlike services (tsx, no build step)
apps/web        React + Vite SPA (dashboard + recipe builder + curator)
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

## Curator

The **Curator** tab bulk-organises loved/liked tracks (or albums) into
playlists, and cleans up likes that were more of a "revisit later" bookmark
than a true favourite.

**Classify & push**: pick base criteria (loved source, play-count range,
last/first-listen and peak-period ranges, tracks or albums) — this is a
Recipe under the hood, run through the same compiler as the Recipe builder.
Matches are grouped by broad genre **family** (asking for "metal" also
catches progressive metal, djent, etc. via the same `genre_rules` hierarchy
recipes use) or, in the finer mode, by each artist's single top genre tag.
Tracks already in a playlist — either pushed by this app before, or found by
**Sync playlists now** (a job that pulls your actual Spotify/TIDAL playlists
and their tracks) — are excluded and reported as a count. Every criteria or
grouping change re-previews live; ticking groups and tracks off before
pushing *is* the refinement step, so there's no separate "refine" stage.
Review the counts, tick which groups to keep, then push — one playlist per
group, with the usual skip/replace/append handling for name clashes.

**Cleanup (bulk unlike)**: filters loved/liked tracks by whether they're
already in a playlist, play count, and how long since they were last played,
then lets you bulk-unlike the ones that were just a "revisit later" tag
rather than a real favourite. A per-track **shield** toggle protects a track
from ever being bulk-unliked here, even if it's barely played — protection is
enforced server-side regardless of what's selected. Unliking calls Spotify's
`DELETE /me/tracks` and TIDAL's `DELETE /userCollectionTracks/.../items`
directly; a **local only** option instead just stops treating the track as
loved in this app's own filters, without touching the streaming service (so
a Last.fm- or TIDAL-sourced love will resurface on the next sync unless also
unloved there). **Last.fm unlikes aren't implemented**: Last.fm's public API
is read-only for an app like this — writing (`track.unlove`) needs a second
API secret, a bespoke signed-request scheme, and a whole separate browser-
approval auth flow distinct from Spotify/TIDAL's OAuth. Last.fm-only loves
are reported and skipped (or removed locally, if you opt in) rather than
silently left half-handled.

## Voice / natural-language assistant

The recipe engine is exposed to assistant LLMs: an MCP server (`npm run mcp`)
plus an OpenClaw skill (`skills/blastfromthepast/`) let you say *"create a
playlist of metal I haven't listened to in 5 years with more than 10 plays"* —
including by voice from Android Auto or a Wear OS watch via a Telegram-connected
agent. Setup, network topologies, and the Claude Desktop alternative are in
[docs/assistant.md](docs/assistant.md).

## Tests

```sh
npm test
npm run typecheck
```
