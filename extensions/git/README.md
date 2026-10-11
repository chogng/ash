# Git capability extension

`ash.git` is the directory-scoped Rust provider for local Git workflows. It owns repository
discovery, status revisions, graph cursors, directory authorization checks, file watchers,
ignore invalidations and automatic fetch. Desktop and TUI consume the existing `git/*` domain
API through App Server. Its browser entry owns Git commands, repository policy, SCM resources, history, quick diff and ignore decorations. Desktop retains generic SCM views, editor models and file persistence.

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

The browser entry runs in a window-owned Worker. The public `ash` module provides SCM
registration, client editor operations and product-granted backend routes. The package manifest
owns commands, menus, submenus, welcome content, colors, settings and English/Chinese NLS.
Use **Manage built-in editor extensions** in either window's command palette to disable
`ash.git` for the current profile. This removes its browser Worker, commands, declarative
contributions and SCM providers, without restarting other active browser extensions. The choice
survives window reloads. Core text models, dirty state, undo, saving, diff editors and other SCM
providers retain their own lifetimes. Re-enabling starts a new Git activation.

This editor enablement does not revoke the directory-scoped Rust capability used by independent
worktree and Turn consumers; execution authorization remains owned by App Server.

`git.getRepositoryContexts` and `git.executeRepositoryCommand` are optional command contracts
for GitHub consumers; core consumers do not import this extension's implementation.

The client checks package provenance and grants before routing backend calls. Draft revisions,
activation generations and provider retirement protect edits and cancel stale callbacks. Multi-diff
sources and file actions use generic resolver and command descriptors; Git scopes, partial staging
and reviewed-content checks stay in the extension. Shared configuration remains the autofetch owner.

This is a trusted product capability process. Generic installed-extension enablement and
third-party OS confinement are separate runtime capabilities; the Ash SCM registration contract does not claim complete VS Code `vscode.scm` API compatibility.

Validation: `just test ash-git-extension` runs the migrated domain suite and launches the real
executable through the product adapter for reads, writes, watcher events, cancellation,
crash recovery, stale cursors, read-only grants and revocation.

History graph requests can select an immutable union of commit revisions. The selection is part
of the connection-owned cursor identity: changing it starts a new traversal, and continuation
requests must repeat it. Omission retains all public references; an empty selection is empty.
The browser history provider resolves branch and tag IDs before querying and resets its retained
pages when their selected revisions change. Closing the connection releases its Git log process.

Committed binary file content includes bounded base64 bytes alongside its binary kind. The
browser adapter decodes them into domain byte arrays; history editors retain these immutable
versions independently of the working tree. The bundled provider contract is version 3. Older
window-facing requests without graph revisions and binary markers without data still decode.

The SCM host bridge advertises optional reference-selection and merge-base callbacks, publishes the upstream reference as an observable snapshot, and serializes immutable binary content as bounded byte arrays. Older providers without these capabilities retain the existing history view and binary marker behavior.
