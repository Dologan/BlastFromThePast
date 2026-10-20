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

cd "$repo"
exec npm run --silent cli --workspace apps/server -- "$@"
