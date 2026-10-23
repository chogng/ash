# Rust language support

This built-in extension contributes Rust language configuration, syntax resources and the
`ashLanguageServers` version 1 acquisition declaration in `package.json`.

Settings lists this extension as **Rust**. Selecting it under **Extensions** opens its
server configuration, including Cargo, diagnostics, completion, formatting, inlay hints,
cache capacity and thread counts. Boolean, string and enum values use the shared Settings
controls. Numeric cache capacities and thread counts have inline inputs, including an
automatic value and named thread modes where supported. Objects and arrays use the shared
JSONC settings editor.

The declaration owns the `rust-analyzer` identity, Rust route, `--version` probe,
`RUSTUP_AUTO_INSTALL=0` environment, Cargo workspace marker and exact official release assets.
Update the six upstream asset URLs, versions, sizes and SHA-256 digests together.
The 194 server setting schemas and defaults match that pinned release. The VS Code
extension's client-only options, such as its debug engine selection, are not server settings;
Ash's server executable and environment remain in Language Services configuration.

To refresh the public schema after updating the pinned runtime, update the expected binary
version in `build/builtin/rustSettings.ts`, then run:

```sh
node build/builtin/rustSettings.ts /absolute/path/to/rust-analyzer
node build/builtin/rustSettings.ts /absolute/path/to/rust-analyzer --check
```

The updater reads `--print-config-schema` from the verified version, retains server value
constraints and defaults, and requires complete Chinese translations before writing the
manifest and English messages. It does not import VS Code client code.

The host uses the existing frozen extension catalog, profile enablement, LSP supervisor and
package store. It probes local executables only on Rust demand and acquires the pinned binary
when none works. A configured path is authoritative; disabling this extension or the server
prevents acquisition. The host holds the package lease until the language server stops.
The Rust toolchain (`cargo` and `rustc`) remains user managed.

## Analysis cache and memory

Ash uses on-demand analysis and retains the started server between visits. This combines
lower startup memory with reuse of analysis already computed. It does not impose a hard
memory limit: the working set depends on the project and requested language features.

| Setting                              | Default           | Behavior                                                                                                                                                                                                         |
| ------------------------------------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rust-analyzer.cachePriming.enable`  | `false`           | Compute analysis on demand rather than eagerly priming the whole workspace. Enabling priming trades more startup work and memory for faster first requests.                                                      |
| `languageServers.autoSuspend`        | `false`           | Keep started servers and their in-memory analysis until the workspace/connection ends or the user stops them. Enable to release idle processes. This is a local application preference for all language servers. |
| `languageServers.idleTimeoutMinutes` | `10`              | When automatic release is enabled, wait this many minutes after the last matching editor closes. Open editors, requests and reported progress defer release.                                                     |
| `rust-analyzer.lru.capacity`         | Automatic (`128`) | Number of cached syntax trees, not MB or a cap on total server memory. Lower values can cause more reparsing.                                                                                                    |
| `rust-analyzer.numThreads`           | Automatic         | Main-loop worker concurrency, not a bound on retained analysis memory.                                                                                                                                           |

The lifecycle controls are under **Editor → Language servers → Analysis cache and memory**.
Rust-specific cache, priming and thread controls are under **Extensions → Rust**. Existing
explicit choices are preserved. Memory-constrained users can enable automatic release;
users returning frequently to Rust can retain the default to avoid repeated cold starts.

On release, the rust-analyzer process exits and its analysis cache is lost. Reopening a
file or requesting language features starts it again and rebuilds analysis on demand.
Basic Tree-sitter highlighting, folding and editing remain available independently.
Cargo's disk build artifacts may be reused, but they do not restore the RA analysis database.
The current server has no persistent analysis checkpoint or corresponding disk quota/TTL.

This retention policy follows the process-lifetime approach of the VS Code rust-analyzer
extension: [activation and explicit server controls](https://github.com/rust-lang/rust-analyzer/blob/2ad81e72b7/editors/code/src/main.ts)
and [client lifecycle](https://github.com/rust-lang/rust-analyzer/blob/2ad81e72b7/editors/code/src/ctx.ts).
Its [`PersistentState`](https://github.com/rust-lang/rust-analyzer/blob/2ad81e72b7/editors/code/src/persistent_state.ts)
stores the installed server's extension version, not analysis results. Ash deliberately
defaults eager priming off instead of inheriting the server's enabled default.

Salsa provides persistence primitives, but restoring a real RA database still requires
serializable selected inputs/results, restored identity maps, dependency invalidation,
and project/configuration reconciliation. The upstream [persistent-cache issue](https://github.com/rust-lang/rust-analyzer/issues/4712)
tracks this engine work. The separate [`ash-rust-analysis`](../../docs/rust-analysis.md)
development bridge does not share the editor LSP database. An LSP-response cache cannot
stand in for restoring that database, especially after dependency or macro changes.

Profile, workspace and folder settings can override priming and the Rust server settings.
The memory default uses the extension configuration registry and reaches rust-analyzer
through the existing directory settings and initialization path.
The other catalog defaults describe the server's behavior. Only explicit profile, workspace
or folder values are forwarded for those settings, so they do not overwrite App Server launch
configuration merely because a setting was added to the catalog.

No separate extension executable or custom RPC is needed for this declarative adapter.
Arbitrary executable extension logic continues to use the public Host RPC and Rust SDK.
