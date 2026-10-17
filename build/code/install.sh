#!/bin/sh
set -eu

repository="chogng/ash"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target="aarch64-apple-darwin"; format="zip" ;;
  Darwin:x86_64) target="x86_64-apple-darwin"; format="zip" ;;
  Linux:aarch64|Linux:arm64) target="aarch64-unknown-linux-gnu"; format="tar.gz" ;;
  Linux:x86_64|Linux:amd64) target="x86_64-unknown-linux-gnu"; format="tar.gz" ;;
  *) printf '%s\n' "Ash Code does not publish a managed package for this platform." >&2; exit 1 ;;
esac

archive="ash-code-$target.$format"
base="https://github.com/$repository/releases/latest/download"
temporary="$(mktemp -d "${TMPDIR:-/tmp}/ash-install.XXXXXX")"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl -fL --retry 3 --proto '=https' --tlsv1.2 "$base/$archive" -o "$temporary/$archive"
curl -fL --retry 3 --proto '=https' --tlsv1.2 "$base/$archive.sha256" -o "$temporary/$archive.sha256"

expected="$(awk -v name="$archive" 'NF == 2 && ($2 == name || $2 == "*" name) { print $1 }' "$temporary/$archive.sha256")"
case "$expected" in
  ""|*[!0-9a-fA-F]*) printf '%s\n' "The Ash Code checksum file is invalid." >&2; exit 1 ;;
esac
[ "${#expected}" -eq 64 ] || { printf '%s\n' "The Ash Code checksum file is invalid." >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$temporary/$archive" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$temporary/$archive" | awk '{print $1}')"
fi
[ "$actual" = "$expected" ] || { printf '%s\n' "The Ash Code package checksum does not match." >&2; exit 1; }

package="$temporary/package"
mkdir "$package"
if [ "$format" = "zip" ]; then
  unzip -q "$temporary/$archive" -d "$package"
else
  tar -xzf "$temporary/$archive" -C "$package"
fi
# The verified package owns publication, locking and launcher generation on every OS.
# Quote the executable too: TMPDIR may contain spaces.
"$package/bin/ash" install-managed --package "$package" \
  --install-root "${ASH_INSTALL_ROOT:-$HOME/.local/share/ash}" \
  --bin-dir "${ASH_BIN_DIR:-$HOME/.local/bin}"
