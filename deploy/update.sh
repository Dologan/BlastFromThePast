#!/usr/bin/env sh
# Rebuild the web app and restart the service, so the live server runs the code
# that's checked out. The post-merge hook runs this after a pull; you can also
# run it by hand. A failed build stops the script before the restart.
#
# The restart needs root: a sudoers rule must allow this user to run
#   /usr/bin/systemctl restart blastfromthepast
# without a password (see DEPLOY.md, section 10). `sudo -n` fails instead of
# prompting, so a missing rule shows up as an error, not a hang.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

# The build writes apps/web/dist and a temp file under node_modules/.vite-temp.
# If either (or anything inside) belongs to another user, e.g. left by a build
# run as bftp, vite fails with EACCES. Check first and say how to fix it.
unwritable="$(find apps/web/dist node_modules/.vite-temp ! -writable -print -quit 2>/dev/null || true)"
if [ ! -e node_modules/.vite-temp ] && [ ! -w node_modules ]; then
  unwritable="node_modules"
fi
if [ -n "$unwritable" ]; then
  echo "[update] $unwritable is not writable by $(id -un), so the build would fail." >&2
  echo "[update] Fix ownership as described in deploy/DEPLOY.md section 10, step 2, then re-run." >&2
  exit 1
fi

echo "[update] building web app"
npm run build

echo "[update] restarting blastfromthepast"
sudo -n /usr/bin/systemctl restart blastfromthepast

echo "[update] done"
