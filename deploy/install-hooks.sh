#!/usr/bin/env sh
# Copies deploy/git-hooks/* into this checkout's .git/hooks. Run once on each
# server, from anywhere inside the checkout. Re-run after changing a hook.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

hooks_dir="$(git rev-parse --git-path hooks)"
mkdir -p "$hooks_dir"

for hook in deploy/git-hooks/*; do
  name="$(basename "$hook")"
  cp "$hook" "$hooks_dir/$name"
  chmod +x "$hooks_dir/$name"
  echo "[install-hooks] installed $name into $hooks_dir"
done
