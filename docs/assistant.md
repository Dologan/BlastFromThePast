# Voice / natural-language playlist assistant

Create playlists by talking to an assistant — *"make a playlist of metal I
haven't listened to in 5 years with more than 10 plays"* — including by voice
from Android Auto or a Wear OS watch.

The LLM lives **outside** the app: an assistant (OpenClaw, Claude, any MCP
client) translates natural language into the app's Recipe JSON, guided by the
tool schemas and skill doc shipped in this repo. The app itself stores no LLM
API key and contains no prompt code.

```
Voice (Android Auto / Wear OS / phone)
  → Telegram message → OpenClaw agent (its LLM + this repo's SKILL.md)
      → MCP tools or curl → BFTP HTTP API → recipe engine → Spotify/TIDAL playlist
```

## Pieces shipped in this repo

| Piece | Where | What it does |
|---|---|---|
| Sync push endpoint | `POST /api/push/sync` | Same body as `/api/push`, but waits and returns the playlist URL + match stats in one round-trip (agents hate polling). Returns `{pending:true}` after ~90 s if the push is still running. |
| Bearer-token guard | `BFTP_API_TOKEN` env or `api.token` setting | Optional. When set, non-loopback requests to `/api/*` need `Authorization: Bearer <token>`. Loopback (the web UI) is always exempt; nothing is enforced if unset. |
| MCP server | `npm run mcp` | stdio MCP server exposing `get_context`, `preview_playlist`, `check_existing_playlist`, `create_playlist`. A thin proxy over the HTTP API — configure with `BFTP_API_URL` (default `http://127.0.0.1:8765`) and optional `BFTP_API_TOKEN`. |
| OpenClaw skill | `skills/blastfromthepast/SKILL.md` | Teaches an OpenClaw agent the recipe grammar, the preview→confirm→create workflow, and the curl fallback. |

## OpenClaw setup

1. Copy (or symlink) `skills/blastfromthepast/` into your OpenClaw workspace's
   `skills/` folder. Set `BFTP_API_URL` (and `BFTP_API_TOKEN` if used) in the
   agent's environment.
2. Optionally register the MCP server for structured tool calls (e.g. with
   [mcporter](https://github.com/instantlyeasy/mcporter) or your OpenClaw
   version's native MCP config):

   ```json
   {
     "command": "npm",
     "args": ["run", "mcp", "--workspace", "apps/server"],
     "cwd": "/path/to/BlastFromThePast",
     "env": { "BFTP_API_URL": "http://127.0.0.1:8765" }
   }
   ```

   The skill works without this (it falls back to curl), but tool schemas give
   the model stronger guardrails.
3. Try it in your OpenClaw chat: *"create a playlist of metal I haven't
   listened to in 5 years with more than 10 plays"*. Expected flow: the agent
   previews, tells you the match count, asks to confirm, then replies with the
   playlist link.

## Voice on Android Auto and Wear OS

The assistant is reached through a messaging channel, which is what makes
hands-free work — Google Assistant can dictate messages to and read replies
from messaging apps in the car, and watches can voice-reply to notifications.

**Telegram (recommended):** create a bot with
[@BotFather](https://t.me/BotFather), wire it as an OpenClaw channel.

- *Android Auto*: "Hey Google, send a Telegram message to \<your bot chat\>" →
  dictate the request; the bot's reply is read aloud and you can voice-reply
  to continue (confirmations like "yes, create it" work naturally).
- *Wear OS*: voice-reply to the bot's notifications from the watch.

**WhatsApp (alternative):** has a first-party Wear OS app with good voice
support, but OpenClaw's WhatsApp channel links your *personal* account via
device-linking (fiddlier, and against WhatsApp ToS) — Telegram's bot API is
the safer default.

Keep replies short — the SKILL.md already instructs the agent to answer in one
or two sentences, since they're often read aloud.

## Network topologies

- **Same machine** (OpenClaw and BFTP on one host): nothing to do — the MCP
  server/curl hit `127.0.0.1:8765`, no token needed.
- **Same tailnet / LAN**: start BFTP with `BFTP_HOST=0.0.0.0` (it binds
  loopback-only by default), point `BFTP_API_URL` at the host, and either set
  `BFTP_API_TOKEN` on both sides or rely on Tailscale ACLs as the security
  boundary. Note: if you set a token *and* browse the web UI from another
  device, the UI's API calls will get 401s (it can't send bearer headers) —
  with Tailscale, prefer no token and let the tailnet be the boundary.
- **Cloud VPS → home**: expose the API to the VPS via Tailscale (or an
  authenticated tunnel like `cloudflared`); set `BFTP_API_TOKEN`. Don't
  port-forward the API to the open internet.

## Claude instead of OpenClaw

The MCP server works with Claude Desktop directly (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "blastfromthepast": {
      "command": "npm",
      "args": ["run", "mcp", "--workspace", "apps/server"],
      "cwd": "/path/to/BlastFromThePast"
    }
  }
}
```

Claude's mobile app requires *remote* custom connectors (streamable HTTP with
auth), which this MCP server doesn't speak yet — that's a known follow-up. For
phone/car/watch voice today, the OpenClaw + Telegram route above is the one
that works end-to-end.

Curator (bulk classify-into-playlists + bulk unlike, see the README) isn't
exposed as MCP tools yet either — a natural follow-up alongside the mobile
connector work above, e.g. *"organise my loved metal tracks into playlists"*.
