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

echo "[update] building web app"
npm run build

echo "[update] restarting blastfromthepast"
sudo -n /usr/bin/systemctl restart blastfromthepast

echo "[update] done"
