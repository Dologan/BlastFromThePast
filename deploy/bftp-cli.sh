#!/usr/bin/env sh
# Run a BlastFromThePast background job from the host, e.g. from cron:
#   deploy/bftp-cli.sh lastfm-sync
#   deploy/bftp-cli.sh enrich
# Loads deploy/bftp.env (the same env file the systemd unit uses) so the CLI
# opens the same database. Jobs run in-process against SQLite and exit when done.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$repo/deploy/bftp.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$repo/deploy/bftp.env"
  set +a
fi

# better-sqlite3 is a native module built for one Node version, and the service
# runs /usr/bin/npm -> /usr/bin/node. Use that same binary rather than whatever
# `node` comes first on PATH (a login shell may have a different Node). Override
# with BFTP_NODE in bftp.env if the service's Node changes.
node_bin="${BFTP_NODE:-/usr/bin/node}"

cd "$repo"
exec "$node_bin" "$repo/node_modules/tsx/dist/cli.mjs" apps/server/src/cli.ts "$@"
