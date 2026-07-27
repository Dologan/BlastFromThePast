# Deploying to a VPS behind Tailscale

Goal: one gate-free copy reachable only from your Tailnet, and one
password-gated copy reachable from the public internet. Both point at the
*same* running app on `127.0.0.1:8765` — nothing in the app itself needs to
change, the gating happens entirely in the reverse-proxy layer in front of
it, since that's the only layer that can actually tell a Tailnet request
from a public one (once traffic reaches the app it's all loopback either
way).

```
Tailnet device  ──▶ tailscale serve :443*  ──────────────▶ 127.0.0.1:8765 (app)
                                                                  ▲
Public internet ──▶ tailscale funnel :8443 ─▶ Caddy :8766 (basic auth) ─┘
```
*or any other free port — see the callout in step 3 if this node already
serves another app on 443.

Two options are covered for the public leg:

- **A. Tailscale Funnel** — no domain needed, TLS handled by Tailscale.
  Recommended; use this unless you specifically want a normal-looking
  domain URL.
- **B. Your own domain + Caddy/Let's Encrypt** — covered at the end, as an
  alternative or addition to A.

Assumes: Ubuntu VPS, root access, Tailscale already installed and joined to
your tailnet, Node.js ≥ 20 available (`apt install nodejs npm` or via
[NodeSource](https://github.com/nodesource/distributions) if the distro
package is too old — check with `node -v`).

## 1. Get the app onto the box

```sh
adduser --system --group --home /opt/blastfromthepast bftp
git clone <your-fork-or-repo-url> /opt/blastfromthepast
cd /opt/blastfromthepast
npm install
npm run build          # builds apps/web/dist, served by the Fastify app
chown -R bftp:bftp /opt/blastfromthepast
```

## 2. Configure and install the systemd service

```sh
cp deploy/bftp.env.example deploy/bftp.env
```

Edit `deploy/bftp.env`:
- `BFTP_PUBLIC_URL` — set this to whichever URL you'll actually use to
  connect Spotify/TIDAL (their OAuth redirect URI is derived from it). The
  Tailnet HTTPS address is the natural choice since it's gate-free:
  `https://<device>.<tailnet-name>.ts.net`. Find your device/tailnet name
  with `tailscale status` and in the [admin console](https://login.tailscale.com/admin/machines).

```sh
ln -s /opt/blastfromthepast/deploy/blastfromthepast.service /etc/systemd/system/blastfromthepast.service
systemctl daemon-reload
systemctl enable --now blastfromthepast
systemctl status blastfromthepast   # should be active/running
curl -s http://127.0.0.1:8765/api/health   # {"ok":true}
```

The unit runs the app as an unprivileged `bftp` user, confined to its own
directory (`ProtectSystem=strict`, `ProtectHome=true`), listening only on
`127.0.0.1` — it is never reachable except through the proxies below. Its
database lives under `/var/lib/blastfromthepast`, which systemd's
`StateDirectory=` creates and makes writable for you automatically.

**If `systemctl status` shows `code=exited, status=226/NAMESPACE`:** that's
systemd failing to set up the service's mount namespace, not the app
itself crashing — check the real reason with
`journalctl -u blastfromthepast -n 50 --no-pager`. The most common cause is
a directory referenced by the unit's sandboxing (`ReadWritePaths=`, etc.)
not existing yet; the unit here avoids that by using `StateDirectory=`
instead, which systemd creates itself, so this shouldn't come up as long as
you're using the unit file as-is. If you edited it, double check that
every path involved already exists (or use `StateDirectory=`/`CacheDirectory=`
rather than pointing `ReadWritePaths=` at something that isn't created
until the app first runs).

## 3. Tailnet-only gate-free access

Tailscale's own device identity is the gate here — nothing in the app or
proxy needs to check a password, only tailnet members can reach this at
all. Make sure HTTPS certs are enabled for your tailnet (admin console →
DNS → "HTTPS Certificates"), then:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8765
tailscale serve status
```

Open `https://<device>.<tailnet-name>.ts.net` from any device in your
tailnet. No login prompt, no exposure outside the tailnet.

**If this node already has another app on `tailscale serve --https=443`**
(e.g. a separate service on the same box), port 443 is taken — `serve`
config is one-hostname-one-thing-per-port, so a second `--https=443` here
would just replace the other app's config, not add to it. The 443/8443/10000
restriction only applies to **Funnel**; plain `tailscale serve` accepts any
port number, so give this app its own port instead, e.g.:

```sh
tailscale serve --bg --https=10000 http://127.0.0.1:8765
```

→ `https://<device>.<tailnet-name>.ts.net:10000`, still gate-free, still
only reachable from the tailnet — just on a different port than the other
app. Run `tailscale serve status` first to see what's already configured
before picking a free port.

If you'd rather both apps *look* like they're on port 443 with their own
hostnames instead of sharing one hostname on different ports, that's what
[Tailscale Services](https://tailscale.com/docs/features/tailscale-services)
(a newer, separate feature from plain `serve`/`funnel`) are for — each
service gets its own virtual hostname/IP via `tailscale serve
--service=svc:<name> --https=443 ...`, so two services can each sit on
their "own" 443. It needs an ACL policy change (a `grants`/`services` entry
authorizing the service, plus admin-console approval unless you set up an
`autoApprovers` rule for it) and is a heavier lift than just picking a free
port — worth it only if you specifically want the port-443-everywhere look.

## 4. Public access, gated — Option A: Tailscale Funnel

Funnel reuses `tailscale serve`'s routing but exposes it to the public
internet, so we point it at a *separate* local port that has a basic-auth
proxy in front of the app, keeping it distinct from the gate-free port 443
above.

Install Caddy (used here only as a tiny local basic-auth proxy, not for
TLS — Tailscale handles TLS for this path):

```sh
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Generate a password hash, then base64-encode it (the Caddyfile
`basic_auth` field wants the base64 form, but `caddy hash-password` only
ever prints the raw `$2a$14$...` bcrypt string — a known inconsistency
between the two, not something you're doing wrong):

```sh
HASH=$(caddy hash-password)
printf '%s' "$HASH" | base64 -w0; echo
```

Copy `deploy/Caddyfile.funnel-auth` to `/etc/caddy/Caddyfile`, filling in
your username and the base64 output above, then reload:

```sh
cp deploy/Caddyfile.funnel-auth /etc/caddy/Caddyfile
# edit /etc/caddy/Caddyfile: set <username> and <hashed-password> (the base64 string)
caddy validate --config /etc/caddy/Caddyfile   # catches config mistakes before reloading
systemctl reload caddy
curl -u '<username>:<password>' http://127.0.0.1:8766/api/health   # {"ok":true}
```

**Why:** the field must be a base64-encoded blob (that's what Caddy's own
docs example shows), not the raw `$2a$14$...` string `caddy hash-password`
prints. Pasting the raw bcrypt string directly fails `caddy validate`/
`reload` with `base64-decoding password: illegal base64 data at input byte
3` — byte 3 is the second `$` in `$2a$14$...`, which isn't valid base64.
Piping straight through (`caddy hash-password | base64 -w0`) also risks
including a trailing newline in the encoded value, which would make the
password never match at login time — hence going through the `$HASH`
variable first, since command substitution strips it.

**Also watch your braces when editing:** `reverse_proxy` must be a
*sibling* of `basic_auth`, not nested inside its `{ }` — if it ends up
inside, Caddy parses `reverse_proxy`/`127.0.0.1:8765` as a bogus
username/password pair, which fails with the *exact same*
`illegal base64 data at input byte 3` message (byte 3 there is the `.`
after `127`), so that error alone doesn't tell you which mistake you've
made. After editing, run `caddy fmt --overwrite /etc/caddy/Caddyfile`
(reindents in place) and re-open the file — a misplaced brace becomes
obvious once it's reformatted, since `reverse_proxy` will visually still
be indented as a child of `basic_auth` instead of back out at the site
block's level.

Now serve that auth-gated port on a second Tailnet HTTPS port and funnel it
to the public internet. Funnel only supports ports 443, 8443, and 10000, and
whichever of those you use here must be different from whatever port you
picked for the gate-free path in step 3 (check with `tailscale serve status`
/ `tailscale funnel status` first — e.g. if another app already owns 443
and you put the gate-free path on 10000, use 8443 here):

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8766
tailscale funnel --bg 8443 on
tailscale funnel status
```

Your password-gated public URL is now
`https://<device>.<tailnet-name>.ts.net:8443`. Test from outside the
tailnet (e.g. your phone on cellular data, or `curl` from elsewhere) — it
should prompt for the basic-auth credentials before returning anything.

No `ufw` changes are required for this path: Funnel traffic arrives over
Tailscale's own encrypted transport (direct or relayed via Tailscale's
DERP servers), handled by `tailscaled` itself, not a raw listening socket
on your public interface.

## 5. Public access, gated — Option B: your own domain + Caddy

If you'd rather use a real domain instead of (or in addition to) Funnel:

1. Point a DNS `A` record for your domain at the VPS's public IP.
2. Open the firewall for HTTP/HTTPS (needed for the ACME challenge and for
   serving):
   ```sh
   ufw allow 80/tcp
   ufw allow 443/tcp
   ```
3. Use `deploy/Caddyfile.domain` instead of/alongside
   `Caddyfile.funnel-auth` — merge both blocks into one
   `/etc/caddy/Caddyfile` if you want both public paths available. Fill in
   your domain, username, and `caddy hash-password` hash:
   ```sh
   systemctl reload caddy
   ```
   Caddy will automatically request and renew a Let's Encrypt certificate
   for the domain the first time it's reloaded with that block present.
4. Visit `https://bftp.example.com` — Caddy will prompt for basic-auth
   credentials, then reverse-proxy to the app.

Since this listens on the public IP directly (not through Tailscale), it's
independent of the Funnel path — you can run either or both.

## 6. Firewall baseline

Regardless of which public option you use:

```sh
ufw allow OpenSSH
ufw enable
ufw status
```

Only open 80/443 if you're using Option B. Tailscale manages its own
control-plane/data-plane connectivity and does not need explicit `ufw`
rules for `serve`/`funnel` to work.

## 7. Redeploying after a git pull

```sh
cd /opt/blastfromthepast
git pull
npm install
npm run build
systemctl restart blastfromthepast
```

## Notes

- The app has its own optional `BFTP_API_TOKEN` bearer-token check
  (`apps/server/src/app.ts`), but it exempts loopback callers — since both
  proxies above connect to the app over `127.0.0.1`, that check will never
  see a non-loopback IP and won't gate anything here. It's unrelated to
  this setup (meant for direct network access from automation/MCP
  clients) and can be left unset.
- If you want to use Spotify/TIDAL OAuth from *both* the Tailnet URL and
  the public/domain URL, register both as redirect URIs on the
  Spotify/TIDAL developer app — `BFTP_PUBLIC_URL` only controls which one
  the server sends in the auth request, so OAuth "Connect" will only work
  from the URL configured there.
- Rotate the basic-auth password by re-running `caddy hash-password` and
  updating the Caddyfile(s), then `systemctl reload caddy`.
