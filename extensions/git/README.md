# Git editor extension

`ash.git` is an independent Rust extension in `extensions/git`, shipped as
`ash-git-extension`. It owns Git commands, repository selection, SCM resources, history,
quick diff, ignore decorations, blame, timeline and multi-file diff policy. Its manifest
owns menus, welcome content, colors, settings and English/Chinese messages. Workbench
owns generic SCM rendering, editor models, undo, dirty state and file persistence.

The extension uses the public Rust SDK's source-control, command, terminal and client
contracts. App Server grants backend routes, directory authority and private credential
services. Its shared `GitRuntime` / `GitService` owns repository facts, status revisions,
graph cursors, watchers and automatic fetch. `crates/git` owns Git execution and parsing.
Agent worktrees, Turn transactions and TUI retain these shared Rust mechanisms without
requiring the editor extension or a JavaScript runtime.

## Settings and capabilities

The package declares all 105 Git settings from the checked-out reference manifest, with
runtime consumers. Policies cover repository, submodule and worktree discovery; branch
naming, protection and ordering; fetch, pull, tags and reviewed force-push; commit scope,
hooks, identity, signing, validation, save checks, message editors and AI co-authors;
SCM presentation; blame and timeline; recycle-bin behavior; clone destinations and window
selection; and terminal authentication and message editing.

Autofetch, its interval and synchronization rebase retain the shared configuration owner.
Legacy user autofetch settings migrate through a revision-checked write and verified read
before their old values are cleared. A conflicting explicit shared configuration is retained
and reported. Other interaction settings use the existing profile/workspace configuration
service. Settings are read again before commands and scoped by repository.

Commit and push requests bind the reviewed HEAD. Push and publish send the reviewed object
explicitly, so a concurrent branch movement cannot substitute another commit. Signing
failures never fall back to unsigned commits. Hooks run unless the configured No Verify
policy permits bypassing them. Save and diagnostic checks run before staging. Draft and
editor revisions prevent stale operations from clearing later edits.

File deletion reviews leaf contents before moving them into the OS recycle bin. A recycle
failure preserves recoverable contents and never falls back to permanent deletion. The
untracked-discard setting explicitly selects recycling or permanent removal. Dirty editor
contents remain under the client's working-copy owner.

Terminal helpers use this executable's `--askpass` and `--editor` modes, an activation-bound
loopback broker and nonpersistent terminal environment contributions. Message files are
checked for replacement before writes. Finish or cancel through the Git terminal-editor
commands. GitHub credentials come from the existing Rust
[`github-authentication`](../github-authentication/README.md) provider, controlled by
`github.gitAuthentication`; credentials never traverse renderer RPC. This does not extract
GitHub PR/Issue business into a new extension.

## Lifecycle and packaging

Activation registers commands and an empty SCM contribution before discovering repositories.
The product host creates a separate activation for each window. Backend discovery and
coalesced SCM publication run independently of UI acknowledgement; an immediate command
waits for discovery and current scoped policy. Retired activations cancel callbacks, helpers,
annotations, terminal environment and providers. Re-enabling creates a new activation.

The background subscription waits for admitted backend notifications and refreshes as soon
as they arrive. It consumes status snapshots rather than ignore invalidation hints, which
arrive before status is ready and would start redundant configuration/discovery work.
A bounded idle tick still updates editor-owned facts such as blame; it does
not delay repository changes. State waits run outside the discovery lock and are cancelled
before shutdown joins the monitor.

Use **Manage built-in editor extensions** to disable `ash.git` for the current profile.
Other SCM providers, editors, undo and saving retain their lifetimes. Shared Rust Git and
Agent/TUI operations remain available under the same directory authorization.

`build/builtin` packages manifest, messages and resources. Cargo/Bazel builds the executable;
backend package layout and signing include it. Rust sources, Cargo inputs and the deleted
TypeScript implementation are excluded from installed extension resources.

`git.getRepositoryContexts` and `git.executeRepositoryCommand` remain optional commands for
GitHub consumers. Core consumers do not import this extension's implementation. The public
SCM registration contract does not claim complete `vscode.scm` compatibility.

History queries retain connection-owned cursors and canonical branch/tag IDs. Selection is
part of cursor identity; changing it begins a new traversal. Immutable binary contents decode
from bounded base64 into byte arrays for history and multi-file comparisons. Input/status
updates preserve SCM resource identity; unchanged diff snapshots retain reviewed models.
Opening an existing SCM resource and asking for its quick-diff baseline use the published
backend status identity and read current file contents through `changeFile`; they do not
force another repository status scan. Explicit refreshes and mutations retain their
authoritative query paths.

## Verification

`tests/host.rs` launches the real Rust executable through the public supervisor and client
contracts in English and Chinese. It covers registration, real staging/commit, settings
migration, history references, binary comparisons, askpass, terminal message finish/cancel,
shutdown and revoked authority. Browser integration tests launch the same executable and
exercise generic SCM/diff UI, settings, drafts, lifecycle and transport policies.

Shared Git authorization, cancellation, watcher, history, removal and AI evidence tests live
in `ash-app-server`, `ash-git` and `ash-file-system`. Protocol/SDK process tests cover framing,
callbacks, cancellation and authority. Packaging tests assert the executable is installed and
Rust build inputs are excluded from extension resources.
