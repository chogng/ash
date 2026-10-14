# Git editor extension

`ash.git` is the TypeScript frontend for local Git workflows. Its browser entry runs in a
window-owned Worker and owns Git commands, repository selection, SCM resources, history,
quick diff, ignore decorations and multi-file diff policy. The manifest owns menus, welcome
content, colors, settings and English/Chinese NLS. Workbench retains generic SCM views,
editor models, undo, dirty state and file persistence.

The extension uses product-granted `backend.request/state` routes through the public `ash`
module. App Server owns directory authorization, repository discovery, status revisions,
graph cursors, watchers and automatic fetch in its shared `GitRuntime` and `GitService`.
`crates/git` owns Git execution and parsing. Agent worktrees and Turn transactions use these
shared Rust primitives directly; TUI uses the existing typed `git/*` App Server contract.
None of these consumers requires the frontend Worker or a separate Git capability process.
Shared configuration remains the only persistent autofetch owner.

## Settings coverage

The checked-out VS Code Git manifest declares 105 settings. Ash currently declares 23;
settings only count here when their consumer is implemented. Frontend interaction preferences
use the profile/workspace configuration service. Autofetch, its interval and synchronization
rebase retain their shared Rust configuration owner.

The additional policies cover smart commit and its scope, signing, empty-commit confirmation,
post-commit push/sync, synchronization confirmation, fetching all remotes before pull, push
notifications, initial branch names, branch prefixes/validation/whitespace, stash message
prefill, short commit hashes and ignored repository presentation. Ignoring a repository hides
its frontend SCM provider; shared Rust Git and Agent operations remain available. Both palette
and history branch creation use the same naming policy before Rust validates the branch.

Signing and empty commits are explicit intents on the existing `git/commit` contract. Signing
requests Git's configured signer; a signing failure does not fall back to an unsigned commit.
Empty commits require a message and use `--allow-empty`. The frontend binds an existing HEAD
before interaction, and Rust checks it before staging. Post-commit operations run only after
successful commit creation. Cancelling a prompt or editing the draft during confirmation
preserves the draft and stops that commit.

The remaining 82 settings need their actual capabilities: repository/submodule/worktree
discovery policies and limits; fetch/pull/tag/force-push policies; branch protection and sorting;
save-before-operation and commit editor/validation; SCM action visibility and lifecycle;
blame and timeline providers; terminal authentication/editor integration; clone destination
and window policy. Shared Git currently disables repository hooks, so VS Code's No Verify
switches would have no independent effect. They are not advertised as implemented.

This package remains a TS browser extension backed by shared Rust Git, rather than a separate
Rust executable. GitHub authentication is a separate Rust provider; GitHub API operations are
still implemented in the shared backend. Adding settings does not migrate these owners.

Git retains `activationEvents: ["*"]` for early frontend availability. Activation registers
commands and an initially empty SCM contribution without awaiting the first backend state read
or repository discovery. `GitService` discovers automatically on workspace/connection updates;
an immediate command waits for that initial state, joins pending discovery and waits for its
provider's first status snapshot. Repository state and file decorations arrive through subsequent SCM updates.
An unchanged package retains its Worker and SCM providers across host refreshes. See
[the host lifecycle mechanisms](../../docs/editor-extensions.md#浏览器-worker-与后端宿主的生命周期)
for the distinction from backend JS activation and independent Rust providers.

`build/builtin` bundles the browser module and its dependencies into the immutable renderer
catalog, with the manifest and NLS. Backend resources retain package metadata; no Git Rust
executable, Cargo inputs or browser sources are installed in the shared runtime package.

Use **Manage built-in editor extensions** to disable `ash.git` for the current profile.
This disposes its Worker, commands, contributions and SCM providers, while other SCM providers,
text/diff editors, undo and saving keep their own lifetimes. The choice survives window reloads;
re-enabling creates a new activation. Frontend enablement does not change shared Rust Git
availability or App Server directory authorization, so Agent and TUI continue to use Git.

`git.getRepositoryContexts` and `git.executeRepositoryCommand` are optional command contracts
for GitHub consumers; core consumers do not import this extension's implementation. The client
checks package provenance and grants before routing backend calls. Draft revisions, activation
generations and provider retirement protect edits and cancel stale callbacks. The Ash SCM
registration contract does not claim complete VS Code `vscode.scm` API compatibility.

History graph requests can select an immutable union of commit revisions. The selection is part
of the connection-owned cursor identity: changing it starts a new traversal, and continuation
requests must repeat it. Omission retains all public references; an empty selection is empty.
The browser history provider resolves branch and tag IDs before querying and resets its retained
pages when their selected revisions change. Closing the connection releases its Git log process.

Committed binary file content includes bounded base64 bytes alongside its binary kind. The
browser adapter decodes them into domain byte arrays; history editors retain these immutable
versions independently of the working tree. The bundled provider contract is version 3. Older
window-facing requests without graph revisions and binary markers without data still decode.

The SCM host bridge advertises optional reference-selection and merge-base callbacks, publishes the upstream and remote default references as observable snapshots, and serializes immutable binary content as bounded byte arrays. Older providers without these capabilities retain the existing history view and binary marker behavior.

Automatic history filtering includes HEAD, its upstream and the configured remote’s symbolic
default branch. Default-reference changes publish independently of commit traversal. A branch
without an upstream exposes **Publish Branch**; the shared Git intent checks the captured branch
and HEAD before pushing and setting tracking. The optional default reference preserves older
history snapshots. Local upstream references resolve in their own branch namespace. Comparison
commands returning from the Worker resolve their repository ID through the SCM service before
requesting immutable contents.

Shared Git authorization, cancellation, watcher and history tests live in `ash-app-server`.
Its stdio integration test exercises actual Git reads and mutations through the TUI client without
editor extensions. Browser extension packaging and Electron enablement tests cover the frontend
boundary separately.
