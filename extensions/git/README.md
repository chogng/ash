# Git capability extension

`ash.git` is the directory-scoped Rust provider for local Git workflows. It owns repository
discovery, status revisions, graph cursors, directory authorization checks, file watchers,
ignore invalidations and automatic fetch. Desktop and TUI consume the existing `git/*` domain
API through App Server. Desktop owns its SCM presentation and editor adapters.

The executable `ash-git-extension` uses the public Rust SDK's typed DataChannel
`git.repository`. App Server admits the exact product executable through its extension
supervisor, binds canonical directory grants, forwards configuration changes and relays events.
Revocation and scope shutdown cancel the provider. Recovery binds a new process incarnation;
failed writes are never replayed, and previous status streams and graph cursors expire.

`crates/git` retains shared Git execution and parsing primitives used by worktrees and Turn
transactions. OS file locks in the user's local data directory coordinate these consumers with
the provider without creating metadata inside read-only repositories.

The shared package builds and signs the executable into `bin/` and stages the manifest and
English/Chinese NLS under `ash-resources/extensions/git`. `build/builtin` owns builtin resource
staging and browser snapshots; Rust sources and Cargo files are excluded from these artifacts.
Unbundled test and Code development launches use an explicit absolute `ASH_GIT_EXTENSION_BIN`;
packaged and Desktop development hosts resolve their declared product layout.

This is a trusted product capability process. Generic installed-extension enablement and
third-party OS confinement are separate runtime capabilities; this implementation does not
provide VS Code's `vscode.scm` author API.

Validation: `just test ash-git-extension` runs the migrated domain suite and launches the real
executable through the product adapter for reads, writes, watcher events, cancellation,
crash recovery, stale cursors, read-only grants and revocation.
