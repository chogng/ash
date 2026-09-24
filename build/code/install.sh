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
version_output="$($package/bin/ash --version)"
version="${version_output#ash }"
[ "$version" != "$version_output" ] && [ -n "$version" ] || {
  printf '%s\n' "The Ash Code package did not report a valid version." >&2
  exit 1
}

install_root="${ASH_INSTALL_ROOT:-$HOME/.local/share/ash}"
launcher_root="${ASH_BIN_DIR:-$HOME/.local/bin}"
release="$version-$(printf '%s' "$actual" | cut -c1-16)"
versions="$install_root/versions"
destination="$versions/$release"
mkdir -p "$versions" "$launcher_root"
if [ ! -d "$destination" ]; then
  mv "$package" "$destination"
fi
[ ! -e "$install_root/current" ] || [ -L "$install_root/current" ] || {
  printf '%s\n' "Refusing to replace an unmanaged Ash current path: $install_root/current" >&2
  exit 1
}
printf '{"schemaVersion":1,"repository":"%s"}\n' "$repository" > "$install_root/install.json"
ln -sfn "versions/$release" "$install_root/.current-next"
mv -f "$install_root/.current-next" "$install_root/current"
launcher="$launcher_root/ash"
if [ ! -e "$launcher" ] && [ ! -L "$launcher" ]; then
  ln -s "$install_root/current/bin/ash" "$launcher"
elif [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$install_root/current/bin/ash" ]; then
  :
else
  printf '%s\n' "Kept the existing launcher at $launcher; run $install_root/current/bin/ash directly or update your launcher." >&2
fi
printf 'Installed Ash Code %s at %s\n' "$version" "$launcher_root/ash"
