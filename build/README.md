# Ash build tools

Product entrypoints compose the shared package tools for development and release:

- `prepare.py` resolves development inputs and publishes packages; `build/desktop/runtimeStore.ts` reads published selections for Electron and Web.
- `desktop/develop.py` combines prepared resources with incremental Desktop binaries and selects a development runtime through `lib/development_store.py`; Code uses the same leased generation storage for its executables.
- `protocol/generate.py` prepares the shared Rust-owned contract; `protocol/artifacts.py` validates portable source fingerprints and packaged artifacts for preparation and assembly.
- `app_server.py` resolves release binaries and resources.
- `remote.py` reads [`remote/package.json`](../remote/package.json), restricts the
  Remote distribution to its declared POSIX targets, and requires bundled Node.
- `lib/package.py` assembles and validates both development and release packages using `lib/package-layout.json`.
- `lib/livekit.py` resolves the locked LiveKit server runtime.
- `sign.py` signs or verifies staged executables and refreshes package metadata.

Runtime discovery, Tool policy, sandbox enforcement, notarization, installer
formats, and update delivery belong to their respective owners.

Root `remote/` owns Remote delivery requirements; `lib/` owns common package
assembly, validation and immutable generation storage. `prepare.py` prepares
the shared development package; `desktop/` owns incremental Desktop selection.
Task entrypoints use the existing pnpm and Just commands, with Vite
and Cargo retaining compilation. Gulp is not required for these tasks.

```text
<package>/
├── ash-package.json
├── bin/
│   ├── ash-app-server-daemon[.exe]
│   ├── ash-app-server[.exe]
│   ├── ash-remote[.exe]
│   ├── ash-remote-server[.exe]
│   └── ash-exec-server[.exe]
├── ash-path/
│   └── rg[.exe]
└── ash-resources/
    ├── protocol/                    # TS types, decoders, JSON Schema, metadata
    ├── protocol-sources.json        # portable source and artifact digests
    ├── tgrep/tgrep[.exe]              # Agent grep runtime
    ├── bwrap                         # Linux only
    ├── node/                           # packaged-node variant only
    │   └── bin/
    │       └── node[.exe]          # shared JavaScript LSP runtime
    ├── skills/
    │   └── skill-creator/SKILL.md
    ├── extensions/
    │   ├── css/package.json
    │   ├── ...
    │   └── yaml/package.json
    ├── product-services/
    │   ├── product-services.json      # official service endpoints
    │   └── marketplace-root.json      # public pinned TUF root
    └── licenses/
        ├── bubblewrap/COPYING        # Linux only
        ├── node/LICENSE                # packaged-node variant only
        ├── tgrep/LICENSE
        ├── ripgrep/
        │   ├── LICENSE-MIT
        │   └── UNLICENSE
        └── vscode/LICENSE.txt        # built-in Editor Extension resources
```

The release entry point is `build/app_server.py`. It prepares `.build/protocol/` and binds its major and generated schema hash into `ash-package.json`. The shared assembler copies the complete contract and its portable source fingerprint into every development and release package; both are covered by the package file manifest and build identity. Preparation can restore matching artifacts from `ASH_PROTOCOL_PACKAGE` (an extracted package root), `--package-root` on `protocol/generate.py`, or a currently selected development package without invoking Cargo. It compares current source contents, dependency manifests, generator code and compiler flags, verifies all protocol artifact digests, and requires matching package protocol metadata. Source changes require a fresh Rust export; runtime major/hash checks remain strict. If `--server-bin` or
`--app-server-daemon-bin` is omitted, `lib/package_binaries.py` builds the corresponding product-neutral
`ash-app-server` or profile-scoped `ash-app-server-daemon` for the selected target.
When `ASH_UPDATE_PUBLIC_KEY` or `--update-public-key` is supplied, the builder binds that trusted key into the App Server component of the immutable package metadata. The release backend uses it to verify independently published stable updates while running; development packages without a key do not check automatically.
It collects all missing first-party executables into one locked Cargo build, including
the Code Mode Host, Rust/V8 JavaScript extension host, Remote programs, and Windows sandbox when required. Prebuilt inputs
are validated before the build and are not rebuilt. Executable paths come from Cargo's
JSON artifact messages; a successful build without a requested artifact is rejected.
Windows builds explicitly select the package's MSVC target, including development
host builds, so an inherited GNU Cargo default cannot select a V8 source build.
The two standalone V8 hosts may also be supplied from Bazel's
`//:v8_host_binaries` via `--code-mode-host-bin` and `--js-extension-host-bin`.
Those targets select MSVC for the complete host closure while the surrounding
Bazel product can keep its GNU ABI; the package communicates with them over IPC.
The upstream Rust rule produces the canonical `.exe` names directly. Resolve
files with `bazel cquery //:v8_host_binaries --output=files` relative to
`bazel info execution_root`; an incoming platform transition can place them in
a configuration-specific output directory.
`lib/ripgrep.py`
maps the package target through `third_party/ripgrep/runtime-lock.json`,
validates archive size and SHA-256 on every use, extracts only the locked
member, and rejects non-regular archive members. `lib/node.py` applies the same
locked size/SHA-256 gate to the shared Node.js runtime, extracts only `node[.exe]`
and its license, and never resolves the packaged runtime from the host `PATH`.
Development and release resolvers share `build/download/artifacts.py`. Downloads hash bounded streams and publish only verified
files from unique temporary paths, so failed requests cannot remove a concurrent result. Official Node.js
releases do not contain musl builds, so musl release jobs must supply an exact
`--node-bin`; the lock still supplies the verified upstream license. For Linux, `bubblewrap.py` validates [`crates/vendor/bubblewrap`](../crates/vendor/bubblewrap/README.md), then builds the `ash-bwrap` binary with the target C compiler and `libcap`; `--bwrap-bin` accepts an already built or signed helper. Microsoft MXC is linked into the Rust runtime. Windows packages include `bin/ash-windows-sandbox.exe` and `bin/ash-windows-sandbox-service.exe`, both owned, checked and signed with the shared runtime. `--windows-sandbox-service-bin` accepts a prebuilt service. The SDK license is copied to `ash-resources/licenses/mxc/LICENSE.md`.
Repository-owned built-in Skills come from
`crates/skills/assets/`; `lib/package.py` rejects linked or malformed Skill trees,
stages them under `ash-resources/skills/`, validates the complete package in a
sibling temporary directory, and renames it into place. It never replaces an
existing output directory. Repository-owned declarative Editor Extensions come from the root
`extensions/` directory and are copied to `ash-resources/extensions/` with the same regular,
unlinked-tree restriction. Their canonical upstream license copy is
`third_party/vscode/LICENSE.txt` (mirrored from the sibling VS Code source checkout) and is copied
once to `ash-resources/licenses/vscode/LICENSE.txt`. Runtime discovery and contribution semantics remain owned by
[`ash-extension-catalog`](../crates/extension-catalog/README.md) and
[`docs/editor-extensions.md`](../docs/editor-extensions.md), not by the package builder.
Product service inputs come from `resources/product-services/`; the shared assembler copies the regular
tree and validates the schema-v2 source list, unique names, the official pin, and every source's
bounded, contained, regular trust-root file before completing a package. The runtime parser owns
endpoint and publisher policy validation and TUF verification.

For release packages, `--javascript-runtime packaged-node` is the default and retains standalone Node
for CLI, browser-bridge, remote, and headless App Server hosts.
`--javascript-runtime host-provided-node` omits the executable, license, and Node
component metadata; this variant is valid only when the product host injects an
exact Node-compatible executable. Electron Desktop uses that variant, declares
its exact `process.execPath` to the Rust App Server, and enters run-as-Node mode
only for JavaScript language-server children. Both alternatives are explicit in
package layout version 2 under `javascriptRuntime.kind`; validators reject a
payload whose files and declared runtime kind disagree.

Desktop development uses the same locks and canonical layout through the Python
entry at `build/prepare.py`. It defaults to the
host-provided runtime variant for Electron; Browser full mode passes
`--javascript-runtime packaged-node`. The assembler builds first-party
executables with Cargo's compact `dev-small` profile, verifies and extracts the required
target-specific runtime archives, stages the result beside
`.build/runtime/dev/store-v1/<target>/<javascript-runtime>/dev-small/packages/<version>/<build-id>`, then publishes an immutable numbered manifest only
after full-file validation. The package store retains the selected and rollback packages and removes older packages only when no process lease is held. Host executables honor `CARGO_TARGET_DIR`, and the assembler
reads the exact executable path from Cargo's JSON artifact messages instead of
guessing a `target` layout. Normal compact host builds, the development
assembler, and the Rust watcher therefore reuse one compilation cache without
creating a second target-triple tree.
On later development starts, checksum-locked archives reuse verified extracted files.
On later development starts, `prepare.py` first fingerprints packaged backend sources,
build settings, package resources, and runtime locks. An unchanged fingerprint
reuses the package selected by the latest manifest before Cargo or runtime
archive resolution runs. When this first check changes, Cargo incrementally
builds the executables and the resolved package inputs get a second fingerprint.
Changes confined to the CLI, terminal crates, or Code signing helper do not
invalidate the Electron backend package; none of those sources are inputs to its
executables or package layout.
If the executable and asset inputs remain unchanged, the selected package is
reused; otherwise the assembler validates and publishes a new package.
Desktop preparation then runs `desktop/develop.py --select-prepared`, which selects the
prepared binaries without invoking Cargo. During Rust watch, `desktop/develop.py` reads
the selected resource package and incrementally builds the backend executables in
the same Cargo cache; it does not assemble, validate, or publish a release package.
Only changed binary contents are copied into immutable objects. Each development
runtime links those objects and the `ash-path/` tools, and copies `ash-resources/`
into its complete layout. Declarative extension and Skill readers require resource
files with one hard link; sharing those files across generations would reject the
bundled contributions. Both copies and executable links remain available after
their preparation package is removed. Linked executable paths must stay on the
same filesystem. The versioned `ash-development.json` identity forces a new
generation when the resource publication contract changes. The runtime uses it
rather than release package metadata, and is never eligible for release installation.

After successful assembly, `desktop/develop.py` atomically writes
`.build/desktop/dev/app-server/current.json` with `version: 3` and a
`runtime: generations/<sha256>` path relative to its directory. Desktop declares
that directory through `ASH_DEV_RUNTIME_ROOT`; managed resources resolve only
inside it. One profile-wide reloader stops local connections, restarts the daemon
once, and reconnects live windows. Custom development launchers may select an
absolute pointer path with `ASH_DEV_APP_SERVER_GENERATION`. Resource or tool-lock
changes require running Desktop preparation again. Every successful selection,
including an unchanged selection, collects unused generations under
`.build/desktop/dev/app-server`. The selected generation is always retained;
older generations are removed only while holding an exclusive `.lease` lock,
so running processes and daemon startup leases keep their complete runtime.
After removing old generations, executable objects with no remaining runtime
hard links are deleted. Publication, collection, and Desktop runtime selection
share `publish.lock`. Desktop starts a `lease-development` command from the
prepared package, outside the collected generation tree. That command reads
the pointer and acquires the runtime lease before releasing the publication
lock. Its stdin follows the Electron owner lifetime; the profile reloader keeps
the selected and pending leases until connections adopt the next runtime.
Thus a publication between selection and process startup cannot delete the
selected runtime. Closing the pipe releases the lease, and an old runtime is
collected on the next publication.
The Python release builder calls the same `lib/package.py` assembler with resolved inputs. It also honors `CARGO_TARGET_DIR`,
and retains its refusal to replace an explicit output directory.

Windows development and release both call the MXC SDK directly. Linux proxy networking additionally requires the SDK's host dependencies: slirp4netns, util-linux and iptables with the required namespace/kernel support.

```sh
python3 -B build/app_server.py \
  --target aarch64-apple-darwin \
  --package-dir /absolute/path/to/ash-package
```

For an Electron-owned package payload:

```sh
python3 -B build/app_server.py \
  --target aarch64-apple-darwin \
  --javascript-runtime host-provided-node \
  --package-dir dist/ash-electron
```

Release jobs that already built or signed binaries should use `--server-bin` and
`--app-server-daemon-bin`, `--remote-bin`, `--remote-server-bin`, `--exec-server-bin`, and
optionally `--rg-bin` or, for the `packaged-node` variant, `--node-bin`; those overrides are copied verbatim and their binary
digest is recorded in `ash-package.json`. `buildId` covers the sorted digest manifest of every package file together with all identity metadata except `buildId` and the file manifest itself; it is not a mutable release selector. Linux jobs can likewise pass
`--bwrap-bin`. Signing and archive serialization must happen after this staging
step. Windows uses the SDK linked into the signed product executables.

The shared runtime builder never includes the `ash` command. Code release jobs pass the completed
runtime to [`build/code/package.py`](code/package.py), which adds `bin/ash[.exe]` and the Ed25519
update trust key, then recomputes the complete package identity. They then run
`build/sign.py`, `build/code/archive.py`, and `ash-update-sign`. macOS and Windows sign and verify every executable before package hashes and
`buildId` are recomputed. macOS produces a rootless `.zip` for Apple notarization; Linux and
Windows produce rootless `.tar.gz` archives. The archives are deterministic; the initial installer checks its named SHA-256 sidecar, while later updates require
the signed descriptor and recheck every package file. CI reads the public key from the
`ASH_UPDATE_PUBLIC_KEY` repository variable and the matching 32-byte hex or base64 signing seed
from the `ASH_UPDATE_SIGNING_KEY` secret. The stable stream changes only through the explicit
`ash-code-promote.yml` workflow.

The runtime package is also system signed, archived, and signed as the separate
`ash-app-server` update product. Its stable pointer is promoted by
`ash-app-server-promote.yml`, independently of the Code stable pointer.

Release administrators derive the public value from the secret seed without exposing it to Cargo
build scripts: build `ash-update-sign`, then invoke the built executable as `ash-update-sign
public-key` with `ASH_UPDATE_SIGNING_KEY` present only in that process. Store the printed value as
`ASH_UPDATE_PUBLIC_KEY`; do not commit the seed or place it in build arguments.

System signing credentials and the reason they are separate from the Ed25519 update key are
documented in `docs/product-update-architecture.md`. Missing macOS or Windows credentials stop a
Release before upload.

Ash Code and Remote runtime `.tar.gz` writers share [`archive.py`](lib/archive.py),
which sets gzip level 6, clears the original filename, and fixes the gzip timestamp at zero.
Each builder owns its tar format, member ordering, permissions, and metadata normalization.

| Target  | Current sandbox package state                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | MXC Seatbelt policy; system launcher                                                                                                         |
| Linux   | `ash-resources/bwrap` is required; MXC owns sandbox/network setup                                                                            |
| Windows | MXC SDK is linked into the runtime; `ash-windows-sandbox.exe` and `ash-windows-sandbox-service.exe` are included and signed with the runtime |

Tests are offline and cover target-lock completeness, both runtime package layouts, the packaged
Node executable/license and host-provided omission, all thirteen built-in
Extension packages, their referenced resources, real file-template declarations, the packaged VS Code
license text, built-in Skill/Extension staging and link
rejection, product-service trust bundle staging, tar/zip member/source extraction, Linux and
Windows helper layouts, executable permissions, refusal to overwrite, and
digest failure cleanup:

```sh
python3 -B scripts/test-python.py
```

Package fixtures own their protocol sources, generated artifacts and fingerprints
in temporary directories. They exercise the production freshness checks without
depending on the workspace's `.build/protocol` cache. Dependency exclusion and
hard-link rejection run on every host; symbolic-link cases run on POSIX hosts.

Development target selection, locked runtime selection, and package reuse are covered by:

```sh
just test-python build
```

## Public grep runtime

`lib/tgrep.py` and development `prepare.py` build the same pinned 1.1.0-ash.b614b8c.4 source, Ash runtime patch and shared file-search ranking/admission sources from
[`third_party/tgrep/runtime-lock.json`](../third_party/tgrep/runtime-lock.json).
All products and Remote runtimes include `ash-resources/tgrep/tgrep[.exe]` and its
MIT license. The component digest and complete file manifest include tgrep; signing
also covers this executable. `--tgrep-bin` is a build-time override, and
`ASH_TGREP_PATH` is an explicit development runtime override. Query execution never
downloads an executable. Adding the component preserves layout version 2 so existing
Ash Code updaters can install the new release.

Run the real App Server search smoke against an assembled package:

```sh
just test-search-package --package-dir /absolute/path/to/package \
  --report /absolute/path/to/search-smoke.json
```

For a host-provided Node development package, optionally pass `--node-bin` with an absolute
Node executable path. Release packages use their bundled Node. The smoke uses an isolated
profile and workspace, removes both search engines from `PATH`, verifies the bundled tgrep
digest, and exercises indexing, result paging, current-disk search and Codebase retrieval over
stdio RPC. It also requires normal App Server exit and tgrep cleanup. A forced shutdown fails
the run; cleanup diagnostics preserve the original failure. The release workflow runs this
check for packages that its runner can execute before signing and uploading them.
