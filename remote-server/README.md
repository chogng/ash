# Remote distribution

`package.json` owns the supported SSH target platforms and the requirement to
bundle Node. Build the remote editing and Agent package from the repository root:

```sh
just remote-package --target aarch64-apple-darwin --package-dir dist/ash-remote
```

[`build/remote.py`](../build/remote.py) reads this declaration before compiling or
downloading anything. Unsupported targets and host-provided Node are rejected.
The entrypoint reuses the App Server package builder and
[`build/lib/package-layout.json`](../build/lib/package-layout.json), so Remote receives the same
base package and integrity checks as other hosts. Service implementations
remain in `remote-server`, `crates/app-server`, and their shared domains.

This is a product package declaration, not an additional npm workspace. Node and
tool versions remain owned by their existing `third_party` locks; Cargo
dependencies remain in the root workspace. No second dependency lock is needed.

The installer consumes a rootless `tar.gz` containing this package. The build
entrypoint assembles the directory. Installation, compatibility checks, activation and rollback are
described in [`docs/remote-development.md`](../docs/remote-development.md).

Windows builds accept `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` from a
matching Visual Studio Developer PowerShell. Use `just remote-package --target
x86_64-pc-windows-msvc --package-dir dist/ash-remote`. Programs use `.exe`; the
client recognizes drive/UNC workspace paths and invokes Windows PowerShell 5.1
explicitly over OpenSSH. Installation uses the Windows inbox
`%SystemRoot%\System32\tar.exe` and defaults to
`%LOCALAPPDATA%\Ash\remote`. Windows x64 and ARM64 are built and verified
on native Windows runners before their archives enter the release catalog.
The first SSH initialization includes installing the profile's immutable package,
so SSH clients allow up to three minutes for that handshake. Later connections
verify and reuse the selection without recopying the package; the smoke runner
reattaches a live terminal after reconnecting to guard its lease deadline.

## Independent release and first connection

Source stays in this repository: [`runtime.md`](runtime.md) documents the connector;
`crates/app-server` owns the backend, and this directory declares the distribution.
The client and Server share a protocol; they do not need separate source repositories.

`.github/workflows/remote-server.yml` builds and verifies each platform before
publishing an immutable `remote-<commit>-<run>-<attempt>` GitHub release. It exercises
connections, files, terminals and an Agent turn, signs/notarizes macOS executables,
and publishes rootless `ash-remote-<target>.tar.gz` archives with separate symbols.
The default release matrix covers macOS, Linux glibc and Windows MSVC ARM64/x64. Musl
remains a source-build target requiring an explicit compatible Node executable.
Manual dispatch may select `platforms=linux` or `platforms=windows` without Apple
signing credentials. Windows Remote archives currently do not use Authenticode or
require an Azure signing account. Their trust comes from the catalog digest bound
into the client product, archive SHA-256 and remote verification before activation.
This exception applies only to the Remote distribution; other Windows product
archives retain their system-signing requirements. Windows application-control
policies can still reject an unsigned runtime.
Windows jobs first install and reuse an 8 MiB binary fixture through an isolated
OpenSSH service, before compiling the full backend. On a prepared native Windows
checkout, run this preflight separately with `python -B
build/release/verify_windows_installer.py --target x86_64-pc-windows-msvc --reports
.build/remote-installer-check`; it does not build or publish the full runtime.
The existing Platform checks workflow also exposes `remote_only=true`, which runs
only this Linux release and its published-asset acceptance checks.

`build/release/remote.py archive` creates a release archive; `catalog` verifies all
archives and requires the complete selected platform set at one protocol/version.
It emits `catalog.json` and `remote-release.json`, which binds the catalog's immutable
HTTPS URL and digest to that protocol/version. Each selected native platform then
tests the published bytes through Desktop's bootstrap and an isolated OpenSSH
server: first connection downloads and installs the missing runtime, verifies the
protocol/schema, starts the backend, edits a file and reconnects without provisioning
again; the installed runtime also passes terminal and Agent smoke checks. Only
after every platform passes does the workflow publish the
`remote-server-release-binding` artifact. Desktop release jobs wait for this
independent release and pass the binding through `ASH_REMOTE_RELEASE_BINDING` or
`--remote-release FILE`. Packaging rejects a protocol/version mismatch, omits the
remote connector and remote archives, and retains the local App Server and SSH client.
The binding is covered by the containing Desktop signature.

When a connection has no compatible installed runtime, the client probes the server
platform, downloads and verifies the selected archive locally, uploads it through
SSH and commits an immutable remote installation. A successful initialize/schema
handshake activates its exact path; later connections reuse it. The remote machine
does not need Internet access. Cancellation clears staging; a failed download,
upload or handshake never activates a partial runtime.
Installation receipts live beside the immutable runtime directory. Reusing an
older installation moves its receipt out of the package before backend activation,
so installation state cannot invalidate the packaged file manifest.

Downloads allow only GitHub's single HTTPS hop to `release-assets.githubusercontent.com`;
other redirects remain rejected. Every hop retains public-Internet-only DNS checks,
and final catalog/archive bytes must match the product-bound digests and sizes.

For local verification, `archive --unsigned` skips production signing only and is
never used by release CI. `build/remote_smoke.py --package-dir PATH --report FILE`
exercises both connector entrypoints. Optional `--ssh PATH --host ALIAS` uses an
isolated loopback OpenSSH host whose test paths share the local filesystem.
`build/release/verify_remote.py --package-dir PATH --binding-file FILE --report FILE`
uses Desktop's actual bootstrap, provisioner and profile store against a real isolated
SSH server. An initially missing runtime triggers the public HTTPS download; a second
connection reuses the activated path without provisioning. Editing, terminal and
Agent smoke checks then run from that installed published package.
On Windows this verifier requires an elevated session and `rustc`; it creates and
removes a separate loopback-only SSH service and a temporary client proxy, without
changing an existing SSH service or the user's SSH configuration.

Before publishing, use the same acceptance entrypoint with `--catalog-dir DIR`
instead of `--binding-file FILE`. `DIR` contains a locally built archive and its
`catalog.json` from `build/release/remote.py catalog`. This exercises the existing
local-artifact provisioner, real SSH installation, Desktop initialization, reconnect,
editing, terminals and a complete Agent turn without publishing a release first.
The report distinguishes local installation from a published HTTPS download; only
the latter verifies the public release download path.

Smoke tests use disposable, credential-free profiles with explicitly selected
private-file secret storage. They do not require a desktop keyring or change the
product's default encrypted storage policy.

For signed macOS publication, set repository variable `ASH_MACOS_SIGNING_IDENTITY`
to the Developer ID Application identity and configure these repository Actions secrets:
`ASH_MACOS_CERTIFICATE_P12` (base64 certificate and private key),
`ASH_MACOS_CERTIFICATE_PASSWORD`, `ASH_MACOS_NOTARY_KEY_P8` (base64 team API key),
`ASH_MACOS_NOTARY_KEY_ID`, and `ASH_MACOS_NOTARY_ISSUER`. Secrets never enter source
or release archives. Linux-only publication does not require these Apple credentials.

Remote packages retain editing, Agent execution, Node and Code Mode. Their fixed
`--media-distribution none` policy does not build, download or include local media,
speech inference, RTC/screen capture, the SFU, or their installation descriptors.
The Remote release workflow prepares only the compiler, debugger/symbol tools and
system libraries required by the actual Remote dependency graph.

See [media and local hosting delivery](../docs/media-delivery.md) for independent build commands,
release staging, first-use installation, offline overrides and verification for
local product hosts. They maintain local `livekit-client`, `realtime-voice` and
`voice-host` programs plus the independently deployed `livekit-server`. Their
packaging and artifact options do not belong to Remote builds.

Desktop remote windows keep calls, dictation and screen capture on the local connection. The remote runtime handles files, terminals and Agent work and rejects device-media requests.
