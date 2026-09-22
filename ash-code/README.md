# `ash-code`

> 命令用法与验证见 [CLI README](cli/README.md)；终端实现与测试见 [TUI README](tui/README.md)；共享请求与通知见 [App Server API](../docs/ash-app-server-api.md)。

`ash-code` is the product-owned source boundary for the `ash code` terminal product.
It contains the `ash-cli` command host, the `ash-tui` presentation shell, and
[host-terminal detection](terminal-detection/README.md).

The product depends on shared contracts and runtime services from `ash-rs`, but the terminal
experience itself does not belong to the shared backend. Raw mode, alternate-screen lifecycle,
keyboard input, Ratatui layout, composer state, and TUI presentation state stay here.

```text
ash-code/cli  → ash-code/tui → ash-app-server-client → shared App Server crates
```

The native `app` product has a separate ownership boundary under `app/`; its reusable GPU UI
crates, including `ash-ui` and `zui`, must not be copied into this product.

The CLI also exposes the native-host Remote management entrypoints used by Desktop and operators:

```text
ash remote connect -> resolve a saved/direct target and open the TUI over host-owned OpenSSH
ash remote probe   -> detect the exact POSIX package target through local OpenSSH
ash remote install -> validate a trusted local packaged-node artifact and install it immutably
ash remote profile -> read, activate, or compatibility-check and roll back shared runtime history
```

These commands delegate SSH/package/profile semantics to `ash-remote-connections`. For
`ash remote connect`, the CLI product host owns OpenSSH and gives the transport-neutral TUI an
already initialized `AppServerSession`; the TUI never owns credentials or process launch.
`--name` resolves the shared credential-free target catalog, while direct `--host`/`--workspace`
uses the same path. A managed connection first tries the stored exact runtime or Remote `ash`.
For runtime-unavailable and protocol-incompatible failures only, it can load the authenticated
catalog bound by a packaged `ash code` installation, or an explicit local/HTTPS catalog plus
SHA-256, install the matching immutable package, and retry once. An explicit `--runtime` is never
replaced automatically. The selected runtime is activated only after executable resolution and
the protocol/schema handshake succeed. `--check` performs the same chain without requiring a TTY
and exits after a clean shutdown. Downloads remain local and the installer uploads an already
validated package; no artifact URL or credential is sent to the Remote host.
`ash remote install --progress json-lines` writes typed installation phases to stderr
while keeping stdout reserved for the final immutable executable path. Native product hosts may
terminate this local command to cancel bootstrap; Desktop does so from its Main-owned pre-Workbench
progress window without exposing artifact paths, SSH options, or credentials to Renderer.

After an interactive SSH TUI has started, a connection loss returns only the durable Session and
Thread identity to the CLI host. The host retries the same verified runtime for 30 seconds with
250ms-to-2s backoff, then starts a fresh TUI connection and reloads the canonical Thread snapshot.
Requests that were in flight and actions queued behind them are discarded rather than replayed.
Runtime disappearance, schema changes, protocol stream failures, and server rejection stop
recovery immediately. The Remote workspace is displayed in the TUI, while local `@file` scanning
is disabled so a local checkout cannot be projected into the Remote conversation; Remote path
completion awaits an App Server-owned contract.

An unpackaged development build has no implicit release trust binding. Use the existing local
bundle explicitly when exercising automatic preparation:

```bash
ash remote connect --name work \
  --runtime-catalog /absolute/path/to/catalog.json \
  --runtime-catalog-sha256 <catalog-sha256> \
  --check
```

Run the product from the repository root:

```bash
cargo run --manifest-path Cargo.toml -p ash-cli
cargo test --manifest-path Cargo.toml -p ash-cli
cargo test --manifest-path Cargo.toml -p ash-tui
bazel test //ash-code/tui:tui-unit-tests
```

Ash-managed installations keep immutable complete packages below a version store and switch a
stable launcher to the selected package. `[tui].autoUpdate` is one of `latest`, `stable`, or
`never`; the first two check at local TUI startup and hourly while it remains open, with network
checks limited to once per six hours per channel. `latest` follows each GitHub Release, while
`stable` follows only versions explicitly promoted by `.github/workflows/ash-code-promote.yml`.
Each update requires an Ed25519 descriptor signed by the release key stored outside the repository,
then verifies the archive SHA-256 and every file digest in `ash-package.json`. Source builds and
packages outside this layout are never rewritten, and changing streams never downgrades an installed
version. Published macOS and Windows executables also carry platform code signatures; macOS release
ZIPs are submitted to Apple notarization before the update descriptor is signed. A completed
background install uses the existing TUI notice row and takes effect after
restart; failures are retained for `ash update --status`. Run `ash update` or
`ash update --channel stable` for an immediate check. Install the latest managed package directly
with:

```bash
curl -fsSL https://chogng.github.io/ash/cli/install.sh | sh
```

Windows PowerShell uses:

```powershell
irm https://chogng.github.io/ash/cli/install.ps1 | iex
```

The [Pages workflow](../.github/workflows/pages.yml) publishes the canonical installers from
`scripts/ash-code/` whenever they change on `main`. Its static artifact contains `.nojekyll`
at the root and the two scripts under `cli/`; no Jekyll build runs. Installation packages
remain GitHub Release assets and must be published before installation can succeed.
On macOS, Linux, and WSL, ensure `~/.local/bin` is on `PATH` to invoke `ash` after installation.

`ash-code/cli/tests/remote_connect.rs` exercises target resolution, the real local Remote Server
broker, trusted runtime preparation, and `--check` through a fake OpenSSH executable.
`ash-code/cli/tests/remote_connect_interactive.rs` runs the real CLI/TUI in a PTY, cuts the first
SSH proxy after the TUI is ready, proves the replacement generation reads the durable Session and
Thread, and exits through the terminal input path.
