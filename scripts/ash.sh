#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

case "${1-}" in
	"")
		exec just ash
		;;
	--connected)
		exec pnpm dev:ui:connected
		;;
	*)
		printf 'Unknown Ash launch mode: %s\n' "$1" >&2
		exit 2
		;;
esac
