#!/bin/sh
# Run inside the requested Linux checkout; Docker launch details are in the README.
set -eu

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
test "$(uname -s)" = Linux
: "${ASH_DNS_SERVER:?set a DNS endpoint reachable over both UDP and TCP}"
for tool in bwrap slirp4netns unshare nsenter ip iptables ip6tables iptables-restore ip6tables-restore curl gpgconf gpg-connect-agent just; do
    command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
# Fail before a build when Docker's default seccomp/capability boundary blocks bwrap.
bwrap --unshare-user --uid 0 --gid 0 --ro-bind / / /bin/true
export ASH_BWRAP_PATH="$(command -v bwrap)"

agent_home="$(mktemp -d)"
export GNUPGHOME="$agent_home"
trap 'gpgconf --kill gpg-agent || true; rm -rf "$agent_home"' EXIT
gpgconf --launch gpg-agent
GPG_AGENT_INFO="$(gpgconf --list-dirs agent-socket)"
ASH_SANDBOX_GPG_SOCKET="$GPG_AGENT_INFO"
export GPG_AGENT_INFO ASH_SANDBOX_GPG_SOCKET

uname -a
cat /etc/os-release
rustc --version
bwrap --version
slirp4netns --version
just verify ash-sandboxing
just verify ash-mxc-sandbox
just verify ash-exec-server
python3 -B scripts/cargo.py build -p ash-network-proxy --example probe --example matrix --profile ci-test --locked
export ASH_NETWORK_PROBE="${CARGO_TARGET_DIR:-$PWD/.build/cargo}/ci-test/examples/probe"
export ASH_NETWORK_MATRIX_PROBE="${CARGO_TARGET_DIR:-$PWD/.build/cargo}/ci-test/examples/matrix"
just test ash-mxc-sandbox --test linux --locked -- --ignored --test-threads=1
just test ash-mxc-sandbox --test sensitive_sockets --locked -- --ignored --test-threads=1
just test ash-mxc-sandbox --test network_matrix --locked -- --ignored --test-threads=1
