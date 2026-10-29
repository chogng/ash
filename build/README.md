# Ash build tools

Product entrypoints compose the shared package tools for development and release:

- `prepare.py` resolves development inputs and publishes packages; `build/desktop/runtimeStore.ts` reads published selections for Electron and Web.
- `desktop/develop.py` combines prepared resources with incremental Desktop binaries and selects a development runtime through `lib/development_store.py`; Code uses the same leased generation storage for its executables.
- `protocol/generate.py` prepares the shared Rust-owned contract; `protocol/artifacts.py` validates portable source fingerprints and packaged artifacts for preparation and assembly.
- `lib/cargo_inputs.py` prepares grammar, V8 and speech link inputs from the selected dependency graph for the Cargo command, Code builds and product packaging. Resource-specific modules retain download, validation and caller-override rules.
- `app_server.py` resolves release binaries and resources.
- `remote.py` reads [`remote-server/package.json`](../remote-server/package.json), restricts the
  Remote distribution to its declared POSIX targets, and requires bundled Node.
  It omits local media builds, attachments and download descriptors.
- `lib/package.py` assembles and validates both development and release packages using `lib/package-layout.json`.
- `lib/livekit.py` resolves the locked LiveKit server runtime.
- `sign.py` signs or verifies staged executables and refreshes package metadata.

Runtime discovery, Tool policy, sandbox enforcement, notarization, installer
formats, and update delivery belong to their respective owners.

Root `remote-server/` owns Remote delivery requirements; `lib/` owns common package
assembly, validation and immutable generation storage. `prepare.py` prepares
the shared development package; `desktop/` owns incremental Desktop selection.
Task entrypoints use the existing pnpm and Just commands, with Vite
and Cargo retaining compilation. Gulp is not required for these tasks.

`pnpm prepare:desktop` prepares Electron, addons and generated frontend inputs.
The Electron launcher prepares and selects the backend before starting a window;
connected Web startup prepares its backend through `startWeb`. Their pnpm startup
hooks prepare frontend inputs only. Explicit `prepare:backend` and
`prepare:backend:web` commands remain available for package preparation, CI and
consumers that deliberately reuse a prepared backend.

Frontend CI checks Renderer sources and smoke automation types once per platform
before building Desktop and both Web modes on Linux, Windows and macOS.
`pnpm valid-layers-check` prepares generated inputs, rejects Node/Electron imports
and native Main-process service references in shared or Web code, and checks each
runtime against its own API declarations. It includes Common, Browser, Worker,
Node, Electron renderer/Main/utility, and the separately compiled sandbox preloads.
Frontend contracts CI runs it before the product checks. Compiler checks use the
pinned Bun with no output; `build/checker/layersChecker.ts` uses the existing
TypeScript Compiler API to follow renamed imports, re-exports and inferred native
service receivers. Host-only globals are also checked by symbol origin, so a
dependency's ambient Node declarations cannot grant those APIs to Web code.

`pnpm build:prepared` requires current generated inputs and successful common,
Renderer and automation checks; it retains TS7 Host compilation and preload
validation. `pnpm test:unit:prepared`, `pnpm build:stanza:prepared` and
`pnpm test:browser:integration:prepared` also require current generated inputs and
the common check from `pnpm prepare:generated`. CI uses these entries after
explicit preparation to avoid repeated lifecycle checks; standalone build and
test commands retain their complete preparation. Build-tool CI compiles the scenario
runner once with `pnpm --dir test/scenario compile`, then uses
`pnpm --dir build run test:prepared` to run the same build tests without repeating
protocol generation. Formatter behavior tests belong to this build suite;
scoped formatter integration reuses that job's dependencies so the
format gate contains only source checks. For repeated unit runs with unchanged
sources and generated inputs, `pnpm test:unit:no-compile` and
`pnpm test:editor:unit:no-compile` run the existing test artifacts with the usual
filters, skipping preparation and compilation. The runner regression suite uses
`pnpm test:unit:runner` after test compilation; `test:main` and frontend CI run it
once separately from business units. Use a compiling
entry again when sources, generated inputs, compiler configuration or dependencies change.
Unit files run in separate processes with at most four workers by default;
`--workers 1` selects serial execution. Output snapshots use filesystem reflinks
where available while retaining independent files when the compiler rebuilds.
`pnpm bundle:web` and `pnpm bundle:web:full` only run
Vite against those prepared, checked sources; use `pnpm build:web` or
`pnpm build:web:full` for a standalone build. The two bundles have different
App Server compile-time flags and share an output directory, so CI runs each
mode's tests before replacing its bundle. Connected Web smoke fixtures reuse the
explicitly prepared backend, rather than compiling it again for every profile;
`test:smoke:browser:full:no-compile` requires that preparation. Electron smoke preparation publishes
the runtime required by startup's Tunnel services and builds Desktop once;
UI and connected tests reuse those artifacts with separate test profiles.

The pinned Bun 1.4.4 runtime owns single-run, no-emit type checking for
Renderer, Common, Protocol, Extensions, Memories, Stanza, build tools, unit-runner
tools, browser integration, smoke automation and scenario sources. Existing pnpm
entrypoints retain their generated-input prehooks. Checks run sequentially;
each Bun process uses all CPU cores by default. To limit contention on a shared
machine, a direct check can use `./node_modules/.bin/bun check -p <config> --threads 4 --all`.
Bun does not write JavaScript or `.tsbuildinfo` files. TS7 7.0.2 retains
Main/Preload and unit/extension-test JavaScript compilation and
`typecheck:web:watch` (Bun 1.4.4 has no standalone check watch mode). Vite/Rolldown
and the scenario runner's esbuild retain bundling. Node, Mocha and Playwright
retain test execution; pnpm retains dependency management. Build tools keep
the TS6 JavaScript Compiler API provided by the `typescript` compatibility alias.

Desktop Host development uses Node input watches for `src`, generated protocol
and localization sources, plus the project configurations and package inputs.
It coalesces saves and invokes one TS7 incremental build at a time, retaining one
pending build for edits received during compilation. It does not use TS7's
dependency-tree watcher, which can receive FSEvents overflows from build caches
and runtime output. `[host] Input changed:` identifies the triggering input;
Electron restarts only when validated Main/Preload output contents change.

Bun also runs the product-icon generator, localization generator, CSS checker
and TypeScript/JavaScript formatter through their existing pnpm scripts.
TypeScript and JavaScript use the TypeScript formatter with `tsfmt.json`, retaining
author-selected line breaks and quote style while normalizing indentation, spaces
and semicolons. Generated TypeScript uses the same formatter. Configuration and
documentation use the pinned `bun fmt` with `.prettierrc.toml` and `.editorconfig`.
The VS Code buffer commands preserve ignored inputs; Markdown code fences are
left to their owning language formatter.
VS Code uses the recommended Simple LSP Client extension to invoke the
workspace Bun executable. `pnpm test:format` compares the configured stdin
commands with file formatting for TS, TSX, JS, JSX, JSON, JSONC, YAML, Markdown,
CSS and HTML.
The `bun: runtime:1.4.4` dependency lets pnpm install the official native runtime
directly, with platform archives and SHA-256 checksums in `pnpm-lock.yaml`.
There is no npm Bun installer or Bun dependency patch. The formatting CI job
installs dependencies with `--ignore-scripts`; native runtimes need no rebuild.
Desktop build, packaging, launch and test runners continue to use Node.

Browser-extension preparation stays on Node: the earlier Bun 1.4.3 comparison
changed the compressed Markdown webview resource bytes.

The TS/JS formatter asks Git for literal requested paths before reading file
status; without arguments it enumerates only the owned source roots.
Localization extraction skips parsing sources without NLS imports or color
registrations; sources containing escapes still use the parser. Source reads
run in batches of at most 32 files, preserving traversal order for diagnostics
and catalogs. Windows x64 Bun 1.4.3 comparisons on the same date used one warmup
and five alternating runs per version, with these median process times:

| Incremental optimization        | Check                          |  Before |   After |
| ------------------------------- | ------------------------------ | ------: | ------: |
| Filter before file status reads | `format:ts build/format.ts`    |  537 ms |  454 ms |
| Skip unrelated syntax trees     | Localization source validation | 2303 ms | 1733 ms |
| Scope Git enumeration           | `format:ts build/format.ts`    |  433 ms |  269 ms |
| Batch source reads              | Localization source validation | 1906 ms | 1686 ms |

Diagnostics matched, and all ten generated localization files had identical
hashes, including the English and Chinese catalogs. The measurements use a warm
filesystem cache and exclude pnpm and protocol-generation prehooks. Each pair
measures the named change against the preceding implementation; separate pairs
must not be added together. Scoped Git enumeration retained all 4547 source-root
inventory entries. Script snapshots, commands, logs and hashes are in
`.build/benchmarks/bun-review-followup/` and `.build/benchmarks/bun-review-io/`.

Development resource watchers serialize generation and keep only one pending
rerun when edits arrive during a build. Localization, browser-extension and icon
generators reread all their inputs, so coalescing retains the latest changes
without retaining each notification. Closing Vite removes listeners, cancels
pending work and suppresses reloads from in-flight generation, including in
middleware mode.

On Windows x64 with Node 24.21.0, eight notifications separated by 75 ms timers
triggered eight localization scans before this change and three to four afterward.
One warmup preceded three alternating runs per version with a warm filesystem
cache. Median time from the first notification until generation drained fell
from 8.718 s to 4.158 s (52%). Synchronous parsing can delay notification timers;
their actual delivery times are recorded. All ten output hashes matched, and
unchanged outputs caused no reloads. This measures a burst of development edits,
not startup or single-save latency. Snapshots, commands, timings and hashes are
in `.build/benchmarks/watch-rebuild/`.

Linux ARM64 Renderer checks were compared in the existing Debian 12 devcontainer
on an Apple M5, with 10 Docker VM CPUs and about 8 GB VM memory. The source and
prepared protocol/localization data were snapshotted onto container storage.
After one warmup, five alternating full checks per checker had median times of
0.814 s for TS7 7.0.2 and 0.337 s for Bun 1.4.3; median peak RSS was 1.042 GiB and
0.341 GiB respectively. Both passed the complete Renderer project, and injected
TS2322/TS2345 diagnostics matched in file, position, code and message. Raw data,
resource limits and the input manifest are in
`.build/benchmarks/bun-renderer-linux-arm64/`. These are warm-cache container
measurements.

The eleven no-emit projects were also compared on macOS/Apple M5 using the
repository's pinned Bun and TS7 packages, prepared inputs, a first process start
and five alternating repeated full checks per checker. Input hashes and file
lists stayed stable within each project's measurement. Diagnostics matched in
file, position, code and message, including existing source errors and isolated
TS2322/TS2345 probes; the build-tools probe also verified `erasableSyntaxOnly`.
Bun's repeated full checks were 1.8–3.8 times faster in this run. Raw commands,
input manifests, diagnostics, timings and peak RSS are in
`.build/benchmarks/bun-typechecks/results.json`. These measurements use a warm
filesystem cache; the first process start does not establish OS cold-cache or
installation performance. Common's unchanged incremental TS7 checks took a
median 137 ms versus Bun's full-check 119 ms; those runs are recorded separately
in `.build/benchmarks/bun-typechecks/common-incremental.json`.

Local Windows x64 acceptance on 2026-10-12 used Bun 1.4.3, TS7 7.0.2 and
Node 24.21.0 with 16 logical CPUs and 63.8 GiB physical memory. Both checkers
passed all eleven no-emit projects. After warmup, five alternating full Renderer
checks had median process times of 1.146 s for Bun and 3.236 s for TS7, with
median peak working sets of 0.391 GiB and 1.040 GiB. Renderer input hashes stayed
stable; TS2322/TS2345 probes matched in file, position, code and message and
emitted no probe files. The five targeted build/lifecycle/host-watch tests,
`pnpm build`, `pnpm build:web`, and one startup smoke each for Browser UI and
Electron UI passed with no test skips. Electron rebuild initially failed Python
discovery and passed with process-local `PYTHON` selecting `scripts/.venv`.
Commands, input manifests, diagnostics and measurements are in
`.build/benchmarks/bun-windows/`. Earlier measurements overlapping a rebuild or
source edits were excluded. These warm-cache local results do not cover the CI
runner, cold installation, cache restoration, full job time or connected-backend
acceptance.

The manual `Bun CI acceptance` workflow runs isolated cold dependency installs
on `ubuntu-24.04` and `windows-latest`, then restores those exact pnpm stores on
fresh runners for offline warm installs. Each job prepares generated inputs,
checks input hashes, alternates five full Renderer checks after warmup and
compares injected TS2322/TS2345 diagnostics. Raw logs and manifests are uploaded
as `bun-ci-*`; the summary includes completed job time and cache step timings.
Run the existing `Frontend` workflow separately for product build and test
acceptance. Cold installation does not establish a cold filesystem cache for
the checker measurements.

The regular `Frontend` workflow also requires the `Windows setup lifecycle`
job. Run it locally on Windows after provisioning the pinned host tools with
`python -B build/setup_acceptance.py --output .build/benchmarks/windows-setup`.
It snapshots the current Git-visible sources into a temporary checkout outside
the repository, with its own Python environment, empty pnpm store and browser
cache. The same workspace must pass a frozen first install, an offline repeat
install, two complete rebuilds and the normal Git browser integration entrypoint
in English and Chinese. It then switches to a local source revision and repeats
that entrypoint, requiring regenerated protocol output and a changed input
fingerprint. `setup.json` and per-command logs retain the results; `--resume`
can retry a failed stage after a source fix without replacing installed state.
Dependency changes or source changes after the baseline test require a fresh
run. This verifies checkout setup with existing host tools, rather than
provisioning an empty Windows installation.

- [x] CI runner comparison completed on 2026-10-12 at `81e60027d` in
      [Bun CI acceptance](https://github.com/chogng/ash/actions/runs/38196463913).
      All four jobs and the report passed with Bun 1.4.3 and TS7 7.0.2. Each
      runner reported four logical CPUs. Successful Renderer checks and injected
      TS2322/TS2345 diagnostics matched, probe checks emitted no files, and input
      hashes stayed stable both within each job and between each platform's cold
      and warm jobs. The five alternating full checks after warmup gave:

| Runner         | pnpm store | Bun ms / MiB | TS7 ms / MiB  | Install s | Cache restore s | Complete job s |
| -------------- | ---------- | ------------ | ------------- | --------- | --------------- | -------------- |
| ubuntu-24.04   | cold       | 1943 / 311.3 | 3241 / 1179.8 | 10.0      | —               | 208            |
| ubuntu-24.04   | restored   | 1909 / 312.3 | 3186 / 1169.5 | 0.5       | 2               | 194            |
| windows-latest | cold       | 1004 / 317.4 | 2101 / 1145.6 | 59.6      | —               | 288            |
| windows-latest | restored   | 2177 / 313.4 | 3918 / 1128.7 | 2.6       | 6               | 356            |

Checker times and peak memory are medians. Linux uses GNU time maximum RSS;
Windows uses peak working set. Installation covers the whole pnpm workspace,
including Bun, TS7 and package build scripts. Warm jobs restore only the pnpm
store and use `pnpm install --offline`; other toolchain and backend caches are
outside that cache. Complete job time includes setup, preparation, both checkers,
cache operations and evidence upload. It does not compare separate Bun and TS7
product jobs: the slower Windows warm job illustrates variation between fresh
runners despite the faster package installation. The checker processes use warm
filesystem caches in both installation phases.

Raw manifests, commands, logs and memory samples are in the four `bun-ci-*`
artifacts; `bun-ci-summary` retains completed jobs and step timings. The separate
[Frontend run](https://github.com/chogng/ash/actions/runs/38196550734) at the same
commit did not pass: Linux build-tool tests reported missing generated language
pack resources in two budget fixtures and a host watch rebuild timeout; macOS
backend preparation could not find the `rusty_v8` static library. Product build
and connected-backend acceptance remain incomplete.

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
    │   └── extensions-root.json      # public pinned TUF root
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
the Code Mode Host, Remote programs, and Windows sandbox when required. The Rust/V8
JavaScript extension host is optional: only `--external-js-ext-bin` explicitly adds
it to release packages; default development and release packages omit it. Existing
packages containing that component remain valid, including integrity and signing
checks. Standard extensions retain the shared JS resources from `resources/extension-host`
and use the bound Node/Electron runtime. Prebuilt inputs
are validated before the build and are not rebuilt. Executable paths come from Cargo's
JSON artifact messages; a successful build without a requested artifact is rejected.
Windows builds explicitly select the package's MSVC target, including development
host builds, so an inherited GNU Cargo default cannot select a V8 source build.
Bazel's `//:v8_host_binaries` contains only the required Code Mode Host, supplied
via `--code-mode-host-bin`. Build the optional extension host explicitly with
`//crates/external-js-ext:ash-external-js-ext` and pass its output through
`--external-js-ext-bin`. Both targets select MSVC for the complete host closure
while the surrounding Bazel product can keep its GNU ABI; the package communicates
with them over IPC. The upstream Rust rule produces the canonical `.exe` names
directly. Resolve files with `bazel cquery <target> --output=files` relative to
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
[`ash-external-ext::packages`](../crates/external-ext/src/packages/README.md) and
[`docs/editor-extensions.md`](../docs/editor-extensions.md), not by the package builder.
Product service inputs come from `resources/product-services/`; the shared assembler copies the regular
tree and validates the schema-v2 source list, unique names, the official pin, and every source's
bounded, contained, regular trust-root file before completing a package. The runtime parser owns
endpoint and publisher policy validation and TUF verification.

For release packages, `--javascript-runtime packaged-node` is the default and retains standalone Node
for CLI, browser-bridge, remote, and headless App Server hosts.
`--javascript-runtime host-provided-node` omits the executable, license, and Node
component metadata; this variant is valid only when the product host injects an
exact Node-compatible executable. Desktop release builders use that variant with
`--electron-version` and bind the package to the exact delivered Electron version.
`build/desktop/package_runtime.py` also composes this variant from a validated
self-contained backend without changing its source; it omits Node, its license,
component and signing record. Electron Desktop declares its exact `process.execPath`
and enters run-as-Node mode for standard JS extensions and Node language servers.
Both alternatives are explicit in
package layout version 2 under `javascriptRuntime.kind`; validators reject a
payload whose files and declared runtime kind disagree.

The daemon atomically commits the installation's Electron path, SHA-256 and
Electron/Node versions with the selected package manifest, without changing signed
package bytes. Ordinary clients reuse that selection; restart probes the frozen
runtime again. Missing or incompatible Electron disables its JS capabilities while
the Rust backend remains available. An explicit selection changes the process
generation when the binding or runtime availability changes. Desktop updates use
the signed whole-application channel; standalone App Server updates cannot replace
a selected Desktop-backed package. CLI, Web and Remote packages retain Node.

`.github/workflows/desktop-runtime-acceptance.yml` is called by Frontend CI and can
be dispatched independently. Windows/macOS build real unsigned Desktop bundles
with compact development backends, check packaged application startup/quit and
terminal/file operations, then verify TUI reuse/restart, crash recovery, binding
upgrade/rollback, incompatible versions and missing Electron. Real Electron LSP
and extension-window tests cover initialization, requests, shutdown and ownership.
Official release optimization, signing and notarization remain in the release workflows.

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
documented in `docs/product-updates.md`. Missing macOS or Windows credentials stop a
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

Build test entrypoints check Rust and host symbol tools before starting any suite.
Run `just check-build-tools` to inspect resolved paths. Windows also discovers the
Visual Studio C++ Clang tools through `vswhere`; custom LLVM locations can use
`ASH_LLVM_BIN`. See [environment setup](../docs/build.md#初始化) for platform requirements.

Package fixtures own their protocol sources, generated artifacts and fingerprints
in temporary directories. They exercise the production freshness checks without
depending on the workspace's `.build/protocol` cache. Dependency exclusion and
hard-link rejection run on every host; symbolic-link cases run on POSIX hosts.

Development target selection, locked runtime selection, and package reuse are covered by:

```sh
just test-python build
```

## Public grep runtime

`lib/tgrep.py` and development `prepare.py` build the same pinned 1.2.3-ash.58629d2.1 source, Ash runtime patch and shared file-search ranking/admission sources from
[`third_party/tgrep/runtime-lock.json`](../third_party/tgrep/runtime-lock.json).
Source builds use the release profile with debug information disabled and symbols
stripped on every target. The profile participates in the cache identity, so a
policy change cannot reuse an executable built with the previous settings.
WSL2 Ubuntu 24.04 x64 validation of 1.2.2-ash.29b7e2e.1 reduced the executable from
21,882,856 to 14,084,552 bytes (35.64%) against the same source built without stripping.
The stripped executable passed the real `ash-tgrep` search and process-lifetime tests;
literal, regex, Unicode, case-insensitive, glob and no-match CLI queries agreed
between disk scans and on-disk indexes, including writes followed by reindexing.
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
