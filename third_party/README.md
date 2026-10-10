# Third-party build inputs and notices

Keep material here only when an active Ash build, runtime, source reuse, or
release notice needs it. Ordinary Rust and JavaScript dependencies belong in
their owning manifests and lockfiles. Downloaded archives and binaries belong
in the ignored `third_party/.cache/`, not in source control.

## Retained inputs

The 2026-10-11 audit compared the local Codex checkout at `806d9732c9` and checked
Ash's actual consumers. Codex's directory layout is a reference; Ash's language
servers, local transcription, calls, and indexed search require additional
inputs.

| Directory                                          | What is stored                                                      | Active Ash consumer                                                                         | Codex comparison                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [`ripgrep`](ripgrep/README.md)                     | Download lock, licenses, Bazel exports                              | Package builders install `rg` in `ash-path`                                                 | Codex downloads its bundled executable through `scripts/codex_package/rg`; it also needs ripgrep                     |
| [`v8`](v8/README.md)                               | Archive/binding locks, source-build rules and compatibility patches | Code Mode and JavaScript extension hosts                                                    | Codex also keeps V8 build rules and patches; Ash uses its own pinned crate/engine pair                               |
| [`rules_rs`](rules_rs/README.md)                   | Bazel compatibility patches and exports                             | Root `MODULE.bazel`                                                                         | Codex also patches its pinned Bazel Rust rules; Ash's GNU Windows execution ABI and linker fixes serve its toolchain |
| [`wezterm`](wezterm/README.md)                     | MIT license and source provenance                                   | `crates/utils/pty/src/win`                                                                  | Codex also retains this license for reused ConPTY code                                                               |
| `vscode`                                           | MIT license only                                                    | Editor source, bundled extensions and package notices                                       | Ash distributes VS Code-derived editor material                                                                      |
| [`node`](node/README.md)                           | Official runtime download lock                                      | Package-provided JavaScript language servers; Electron development supplies its own runtime | Ash's shared language-server runtime needs its own version and checksum lock                                         |
| [`sherpa-onnx`](sherpa-onnx/README.md)             | Static-library download lock                                        | `ash-realtime-voice`; Cargo/build wrappers prepare verified link inputs                     | Ash's local speech recognition uses Sherpa; this is not a copied Rust crate                                          |
| [`livekit`](livekit/README.md)                     | Server download/source lock, license and notices                    | Package builders and local call services                                                    | Ash runs a separate LiveKit server for calls                                                                         |
| [`livekit-rust-sdks`](livekit-rust-sdks/README.md) | License and notices only                                            | LiveKit SDK dependencies and release package notices                                        | SDK source stays under Cargo management                                                                              |
| [`tgrep`](tgrep/README.md)                         | Fixed source archive, integration patch, checksums and MIT license  | `build/lib/tgrep.py`, `ash-tgrep`, file search and package builders                         | Ash's indexed search uses this separate program; the source archive and patch are active build inputs                |

The tgrep source snapshot is the only retained upstream program source here.
Its build verifies the source, patch and shared ranking/discovery digests before
compiling. V8 engine source and all runtime downloads remain in build caches.
Neither V8 nor Sherpa keeps a local Rust package copy.

## Removed residual inputs

The same audit removed `candle-onnx`: neither the Cargo workspace nor its
lockfile had a consumer for this source copy. Its unused `protoc-bin-vendored`
Bazel annotations were removed too. `third_party/bubblewrap` exported files
that did not exist; the working Linux build uses `crates/vendor/bubblewrap`,
as Codex uses its own vendor directory. The PowerShell staging placeholder had
no download, build or package consumer. Ash continues to resolve installed
Windows shells through its existing shell service.

## Release obligations

Locks own upstream versions, targets and SHA-256 values. Build and package
entrypoints must verify downloaded inputs and preserve the required licenses
and notices. Review each component's README before updating it.

License texts stay with the material they cover: runtime notices here,
component assets such as fonts under `crates/utils/typst/licenses`, and Desktop
notices in the root `THIRD_PARTY_NOTICES.md` and `licenses/`. Source reuse still
requires its upstream notice even when no upstream executable is shipped.
