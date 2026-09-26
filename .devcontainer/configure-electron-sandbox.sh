#!/bin/sh
set -eu

# Electron's setuid helper must be owned by root after pnpm populates the mounted volume.
sandbox=$(realpath /workspaces/ash/app-ts/node_modules/electron/dist/chrome-sandbox)
case "$sandbox" in
    /workspaces/ash/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox) ;;
    *) printf '%s\n' "Unexpected Electron sandbox path: $sandbox" >&2; exit 1 ;;
esac

chown root:root "$sandbox"
chmod 4755 "$sandbox"
