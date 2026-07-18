---
name: blastfromthepast
description: Create and publish Spotify/TIDAL playlists from the user's listening history by natural language — e.g. "make a playlist of metal I haven't listened to in 5 years with more than 10 plays". Use whenever the user asks for a playlist based on their own history, forgotten music, rediscoveries, anniversaries, genres, or play counts.
version: 0.1.0
metadata:
  openclaw:
    requires:
      bins:
        - curl
    envVars:
      - name: BFTP_API_URL
        required: false
        description: Base URL of the BlastFromThePast server (default http://127.0.0.1:8765).
      - name: BFTP_API_TOKEN
        required: false
        description: Bearer token, only needed when the server enforces auth for remote clients.
---

# BlastFromThePast — playlist recipes from listening history

BlastFromThePast (BFTP) is the user's self-hosted app holding their full Last.fm
listening history (play counts, first/last listen dates, genres, countries,
loved tracks). It compiles a JSON "recipe" of filters into a track list and
publishes it as a playlist on Spotify or TIDAL.

**Your job:** translate the user's natural-language request into a recipe,
preview it, confirm, then create the playlist and reply with its link.

If the `blastfromthepast` MCP server is configured, prefer its tools
(`get_context`, `preview_playlist`, `check_existing_playlist`,
`create_playlist`) — they take the same recipe JSON described below.
Otherwise use `curl` as shown. `BASE` below means `${BFTP_API_URL:-http://127.0.0.1:8765}`;
if `BFTP_API_TOKEN` is set, add `-H "Authorization: Bearer $BFTP_API_TOKEN"` to every call.

## Workflow (always in this order)

1. **Ground the request** (only when unsure a genre/country exists, or which service to use):
   `curl -s $BASE/api/facets` → `{genres, countries}`; `curl -s $BASE/api/settings` → `.defaultService`;
   `curl -s $BASE/api/auth/status` → which services are connected.
2. **Build the recipe** (grammar below).
3. **Preview** — never skip this:
   `curl -s -X POST $BASE/api/recipes/preview -H 'Content-Type: application/json' -d '<recipe JSON>'`
   → `{matched, rows:[...]}`. Tell the user the count and 2–3 example tracks and ask to confirm
   ("42 tracks matched, e.g. Ghost of Perdition by Opeth — create it?"). If 0 matched or far too many,
   adjust filters and preview again instead.
4. **Check for a name clash** before pushing:
   `curl -s "$BASE/api/push/existing?service=<svc>&name=<urlencoded name>"`.
   If `.existing` is non-null, ask: replace its contents, append to it, or create new anyway.
5. **Create** (after the user confirms):
   ```
   curl -s -X POST $BASE/api/push/sync -H 'Content-Type: application/json' -d '{
     "recipe": <recipe>, "service": "<spotify|tidal>", "name": "<playlist name>",
     "mode": "<new|replace|append>", "existingPlaylistId": "<only for replace/append>"
   }'
   ```
   → `{result: {playlistUrl, matchedCount, unmatched, ...}}`. Reply with the playlist URL and match count;
   mention unmatched tracks only if there are any. If the response is `{pending: true}`, say the playlist
   is still being built and will appear shortly (poll `GET $BASE/api/push/result` if the user asks).
   Use the service the user named, else `defaultService`, else ask.

## Recipe grammar

`{"filters": [...], "output": {...}}` — filters are ANDed; values inside one clause are ORed.

Canonical example — *"metal I haven't played in 5 years with more than 10 plays"*:

```json
{"filters": [
   {"type": "genre", "anyOf": ["metal"]},
   {"type": "notPlayedInDays", "days": 1825},
   {"type": "playcount", "min": 10}
 ],
 "output": {"mode": "tracks", "sort": "weighted_random", "limit": 50}}
```

Filter clauses (all day counts: week=7, month=30, year=365):

| Clause | Meaning |
|---|---|
| `{"type":"genre","anyOf":["metal"],"mode":"canonical","negate":false}` | Genre; canonical (default) includes subgenres; `negate` excludes. Genre names are lowercase; check `/api/facets`. |
| `{"type":"country","anyOf":["SE"],"negate":false}` | Artist country, ISO alpha-2 codes. |
| `{"type":"notPlayedInDays","days":N}` | Not played for at least N days (the "forgotten" filter). |
| `{"type":"playedInDays","days":N}` | Played within the last N days. |
| `{"type":"playcount","min":N,"max":M}` | Total plays range (either bound optional). |
| `{"type":"loved","source":"lastfm"\|"spotify"}` | Loved/liked only (omit source for either). |
| `{"type":"firstListen","after":"YYYY-MM-DD","before":"YYYY-MM-DD"}` | Discovered in a date range ("music from my 2014 phase"). |
| `{"type":"lastListen","after":...,"before":...}` | Last played in a date range. |
| `{"type":"peakMonth","after":...,"before":...}` | Heaviest-listening month fell in the range. |
| `{"type":"anniversary","field":"firstListen","windowDays":3}` | First/last listened around today's date in past years. |
| `{"type":"gapDays","minDays":N,"maxDays":M,"infinite":true}` | Gap between plays; `infinite` = never returned from its longest pause. |
| `{"type":"excludeRecentlyPlaylisted","days":N}` | Skip tracks already pushed to a playlist recently (good default: 30). |

Output: `mode` `"tracks"` (playlists — the usual choice) or `"albums"`; `sort` one of
`weighted_random` (shuffle favouring favourites — good default), `neglect` (most-played-longest-ago first),
`playcount_desc`, `playcount_asc`, `recent`, `oldest_first_listen`, `random`; `limit` (default 50);
optional `perArtistCap` (2–3 keeps playlists varied).

## Voice etiquette

Replies are often read aloud (Android Auto / watch): keep them to one or two short sentences,
lead with the outcome ("Done — 42 tracks, here's the link"), and ask at most one question at a time.
