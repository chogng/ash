#!/bin/sh
set -eu

sudo chown node:node \
    node_modules \
    build/node_modules \
    .build \
    scripts/.venv \
    third_party/.cache \
    /home/node/.cache \
    /home/node/.cargo/registry \
    /home/node/.cargo/git

just install
pnpm install --frozen-lockfile
sudo /usr/local/bin/ash-configure-electron-sandbox
pnpm exec playwright install chromium

# Fetch the locked Linux media server before the first full Web build.
python -B build/lib/livekit.py "$(rustc -vV | awk '$1 == "host:" { print $2 }')"
