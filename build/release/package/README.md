# Ash package builder

This directory owns the shared Ash release package:

- `build.py` resolves binaries and resources, then stages the canonical layout.
- `layout.py` validates package contents and owns the file digests and `buildId`.
- `sign.py` signs or verifies staged executables and refreshes package metadata.

Runtime discovery, Tool policy, sandbox enforcement, notarization, installer
formats, and update delivery belong to their respective owners.

```text
<package>/
├── ash-package.json
├── bin/
│   ├── ash[.exe]                   # Ash Code release variant only
│   ├── ash-app-server-daemon[.exe]
│   ├── ash-app-server[.exe]
│   ├── ash-remote[.exe]
│   ├── ash-remote-server[.exe]
│   └── ash-exec-server[.exe]
├── ash-path/
│   └── rg[.exe]
└── ash-resources/
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
        ├── ripgrep/
        │   ├── LICENSE-MIT
        │   └── UNLICENSE
        └── vscode/LICENSE.txt        # built-in Editor Extension resources
```

The stable entry point is `build/release/package/build.py`. Before resolving product binaries, it runs the App Server protocol generator into a temporary directory and binds the current protocol major, revision, and schema hash into `ash-package.json`; it does not rewrite checked-in fixtures. `verify:protocol` remains an explicit fixture check, while `generate:protocol` refreshes repository fixtures when they are intentionally being reviewed. If `--server-bin` or
`--app-server-daemon-bin` is omitted, `cargo.py` builds the corresponding product-neutral
`ash-app-server` or profile-scoped `ash-app-server-daemon` for the selected target.
It collects all missing first-party executables into one locked Cargo build, including
the Code Mode Host, Remote programs, and Windows sandbox when required. Prebuilt inputs
are validated before the build and are not rebuilt. Executable paths come from Cargo's
JSON artifact messages; a successful build without a requested artifact is rejected.
`ripgrep.py`
maps the package target through `third_party/ripgrep/runtime-lock.json`,
validates archive size and SHA-256 on every use, extracts only the locked
member, and rejects non-regular archive members. `node.py` applies the same
locked size/SHA-256 gate to the shared Node.js runtime, extracts only `node[.exe]`
and its license, and never resolves Node from the host `PATH`. Official Node.js
releases do not contain musl builds, so musl release jobs must supply an exact
`--node-bin`; the lock still supplies the verified upstream license. For Linux, `bubblewrap.py` validates [`ash-rs/vendor/bubblewrap`](../../../ash-rs/vendor/bubblewrap/README.md), then builds the `ash-bwrap` binary with the target C compiler and `libcap`; `--bwrap-bin` accepts an already built or signed helper. Microsoft MXC is linked into the Rust runtime. No Ash sandbox helper executables or machine service are packaged. The SDK license is copied to `ash-resources/licenses/mxc/LICENSE.md`.
Repository-owned built-in Skills come from
`ash-rs/skills/assets/`; `layout.py` rejects linked or malformed Skill trees,
stages them under `ash-resources/skills/`, validates the complete package in a
sibling temporary directory, and renames it into place. It never replaces an
existing output directory. Repository-owned declarative Editor Extensions come from the root
`extensions/` directory and are copied to `ash-resources/extensions/` with the same regular,
unlinked-tree restriction. Their canonical upstream license copy is
`third_party/vscode/LICENSE.txt` (mirrored from the sibling VS Code source checkout) and is copied
once to `ash-resources/licenses/vscode/LICENSE.txt`. Runtime discovery and contribution semantics remain owned by
[`ash-extensions`](../../../ash-rs/extensions/README.md) and
[`docs/editor-extensions.md`](../../../docs/editor-extensions.md), not by the package builder.
Product service inputs come from `resources/product-services/`; both assemblers copy the regular
tree and validate the schema-v2 source list, unique names, the official pin, and every source's
bounded, contained, regular trust-root file before completing a package. The runtime parser owns
endpoint and publisher policy validation and TUF verification.

`--javascript-runtime packaged-node` is the default and retains standalone Node
for CLI, browser-bridge, remote, and headless App Server hosts.
`--javascript-runtime host-provided-node` omits the executable, license, and Node
component metadata; this variant is valid only when the product host injects an
exact Node-compatible executable. Electron Desktop uses that variant, declares
its exact `process.execPath` to the Rust App Server, and enters run-as-Node mode
only for JavaScript language-server children. Both alternatives are explicit in
package layout version 2 under `javascriptRuntime.kind`; validators reject a
payload whose files and declared runtime kind disagree.

Desktop development uses the same locks and canonical layout through the Node
assembler at `build/ash-package/prepare.ts`. It defaults to the
host-provided runtime variant for Electron; Browser full mode passes
`--javascript-runtime packaged-node`. The assembler builds first-party
executables with Cargo's compact `dev-small` profile, verifies and extracts the required
target-specific runtime archives, stages the result beside
`.build/ash-package/dev/store-v1/<target>/<javascript-runtime>/dev-small/packages/<version>/<build-id>`, then publishes an immutable numbered manifest only
after full-file validation. The package store retains the selected and rollback packages and removes older packages only when no process lease is held. Host executables honor `CARGO_TARGET_DIR`, and the assembler
reads the exact executable path from Cargo's JSON artifact messages instead of
guessing a `target` layout. Normal compact host builds, the development
assembler, and the Rust watcher therefore reuse one compilation cache without
creating a second target-triple tree. It neither installs nor invokes Python.
This Python package remains the release builder, also honors `CARGO_TARGET_DIR`,
and retains its refusal to replace an explicit output directory.

Windows development and release both call the MXC SDK directly. Linux proxy networking additionally requires the SDK's host dependencies: slirp4netns, util-linux and iptables with the required namespace/kernel support.

```sh
python3 -B build/release/package/build.py \
  --target aarch64-apple-darwin \
  --package-dir /absolute/path/to/ash-package
```

For an Electron-owned package payload:

```sh
python3 -B build/release/package/build.py \
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

Ash Code release jobs pass `--cli-bin` and `--update-public-key` to include `bin/ash[.exe]`, its
digest, and the Ed25519 update trust key. They then run
`build/release/package/sign.py`, `build/release/code/archive.py`, and
`ash-update-sign`. macOS and Windows sign and verify every executable before package hashes and
`buildId` are recomputed. macOS produces a rootless `.zip` for Apple notarization; Linux and
Windows produce rootless `.tar.gz` archives. The archives are deterministic; the initial installer checks its named SHA-256 sidecar, while later updates require
the signed descriptor and recheck every package file. CI reads the public key from the
`ASH_UPDATE_PUBLIC_KEY` repository variable and the matching 32-byte hex or base64 signing seed
from the `ASH_UPDATE_SIGNING_KEY` secret. The stable stream changes only through the explicit
`ash-code-promote.yml` workflow.

Release administrators derive the public value from the secret seed without exposing it to Cargo
build scripts: build `ash-update-sign`, then invoke the built executable as `ash-update-sign
public-key` with `ASH_UPDATE_SIGNING_KEY` present only in that process. Store the printed value as
`ASH_UPDATE_PUBLIC_KEY`; do not commit the seed or place it in build arguments.

System signing credentials and the reason they are separate from the Ed25519 update key are
documented in `docs/product-update-architecture.md`. Missing macOS or Windows credentials stop a
Release before upload.

For app Remote delivery, one or more completed packaged-node directories can be serialized into
deterministic rootless archives and a strict local catalog:

```sh
python3 -B build/release/remote/bundle.py \
  --bundle-dir /absolute/path/to/remote-runtimes \
  --package-dir /absolute/path/to/x86_64-linux-package \
  --package-dir /absolute/path/to/aarch64-linux-package
```

The bundle builder rejects links, special files, duplicate targets, non-POSIX targets and package
metadata that does not match the canonical Remote contract. It records compressed size, unpacked
size and SHA-256 for each deterministic archive. Product packaging, not this canonical package
builder, authenticates the resulting catalog.

Ash Code and Remote runtime `.tar.gz` writers share [`archive.py`](../archive.py),
which sets gzip level 6, clears the original filename, and fixes the gzip timestamp at zero.
Each builder owns its tar format, member ordering, permissions, and metadata normalization.

| Target | Current sandbox package state |
| --- | --- |
| macOS | MXC Seatbelt policy; system launcher |
| Linux | `ash-resources/bwrap` is required; MXC owns sandbox/network setup |
| Windows | MXC SDK is linked into the runtime; no separate Ash sandbox executable |

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

The Node development assembler's target selection, locked ripgrep/Node selection,
and atomic replacement behavior are covered by:

```sh
node --test build/ash-package/prepare.test.ts
```
