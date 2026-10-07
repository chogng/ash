#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

case "${1-}" in
	"")
		if [[ "$OSTYPE" == darwin* ]]; then
			exec uv run --python 3.12 just ash-desktop
		fi
		exec just ash-desktop
		;;
	--connected)
		if [[ "$OSTYPE" == darwin* ]]; then
			exec uv run --python 3.12 pnpm dev:ui:connected
		fi
		exec pnpm dev:ui:connected
		;;
	*)
		printf 'Unknown Ash Desktop launch mode: %s\n' "$1" >&2
		exit 2
		;;
esac
