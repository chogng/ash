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

## Path and API boundaries

`model.rs` contains extension-owned domain values. Repository roots and workspace
folders carry `PathUri`; `paths.rs::RepoPath` carries a validated, non-empty Git
relative name using `/`. It does not reinterpret a POSIX filename through Windows
path rules. Resource containment and resolution use `ash-utils-path-uri`; actual
filesystem access converts to an absolute host path at the IO boundary. Lexical
containment does not replace backend filesystem authorization or identity checks.

`api.rs` is the only owner of backend method names, JSON request assembly, response
decoding, request policy and invocation-scoped askpass leases. Commands call typed
operations with domain inputs and results. A reviewed removal carries its file
revisions and HEAD; an index edit carries its comparison snapshot and typed
selection. The shared backend still performs the authoritative concurrency checks.
The public editor SDK uses JSON for presentation and command arguments; those
values do not serve as a second repository state or backend transport contract.

Worktree and clone responses enter through the adapter using an explicit target
path convention. Configuration accepts absolute paths or file URIs at its boundary.
Folder selection returns a URI resolved by the client's shared path service; the
extension never interprets the selected path using its own process platform.
An invalid file path fails instead of being displayed as the repository root.

## Settings and capabilities

The package declares Git settings with runtime consumers. Policies cover repository,
submodule and worktree discovery; branch
naming, protection and ordering; fetch, pull, tags and reviewed force-push; commit scope,
hooks, identity, signing, validation, save checks, message editors and AI co-authors;
SCM presentation; blame and timeline; recycle-bin behavior; clone destinations and window
selection; and terminal authentication and message editing.

Autofetch, its interval and synchronization rebase retain the shared configuration owner.
Legacy user autofetch settings migrate through a revision-checked write and verified read
before their old values are cleared. A conflicting explicit shared configuration is retained
and reported. Other interaction settings use the existing profile/workspace configuration
service. Settings are read again before commands and scoped by repository.

Synchronization confirms the tracked remote branch when `git.confirmSync` is enabled.
The modal offers OK, OK without future prompts, and Cancel; suppressing future prompts
updates that existing setting at user scope. Cancel stops before any fetch, pull or push.
Synchronization pulls the reviewed upstream explicitly, then pushes only if the resulting
status has outgoing commits. Read-only remotes (`no_push`) skip confirmation and push.
`git.fetchOnPull`, `git.pullTags`, `git.autoStash` and `git.followTagsWhenSync` still govern
their respective transport stages; `git.rebaseWhenSync` retains its shared setting owner.
Disabling `git.pullTags` or `git.pruneOnFetch` omits the corresponding command-line
override, preserving Git's own tag-following and pruning configuration. Rewritten-history
and rejected-tag prompts persist their Always choices through `git.ignoreRebaseWarning`
and `git.replaceTagsWhenPull`. Tag replacement fetches only the rejected tags before one
pull retry. Cancellation refreshes repository state and stops synchronization before push;
`git.supportCancellation` enables fetch/pull cancellation even with `git.showProgress`
disabled. Push has no cancellation action.

The status-bar sync icon rotates during sync, pull, push and publish, after confirmation.
It follows `git.enableStatusBarSync`, hides without remotes, and shows only incoming counts
for read-only remotes. An untracked branch invokes publish; multiple remotes offer a picker
with Add Remote. Remote-source publisher and push-error handler provider registries are
not implemented. Automatic stash uses Git's `--autostash`.

Git must meet the shared [minimum version requirement](../../crates/git/README.md#git-版本要求)
(currently 2.40.0). Installation detection distinguishes missing Git from an unsupported
version. Unsupported installations show one localized upgrade warning per activation or
installation configuration change, and repository discovery stays disabled. The warning
cannot be suppressed with `git.ignoreMissingGitWarning`. Upgrade Git, update `git.path`
if configured, and restart Ash. Installation support is decided by the shared Git owner;
the editor does not apply platform-specific version rules or downgrade commands.

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
loopback broker and nonpersistent terminal environment contributions. The broker starts only
when a Git operation or terminal needs a helper. Its listener blocks while idle and is woken
by a local connection during shutdown. Message files are
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

The Workbench separates process authority from executable registration content.
Replacing one registration cancels only that registration's calls; retiring the
process cancels every call belonging to it. SCM, output and status-bar snapshots
retain their own revision and reconciliation owners. Neither a Git status update
nor another extension's enablement change replaces an unaffected command lifetime.

The background subscription waits for admitted backend notifications and refreshes as soon
as they arrive. It consumes status snapshots rather than ignore invalidation hints, which
arrive before status is ready and would start redundant configuration/discovery work.
Cursor and unsaved-text changes emit coalesced editor revisions without invalidating discovery.
The private backend-state facts retain `editorFoldersChanged` separately from a full reset.
Git checks changed editor resources against its known repository roots; switching among
subdirectories only updates blame, while an unknown workspace path still enters discovery.
Blame reads metadata first and requests full text only after the active signature changes.
Idle waits renew after 20 seconds, below the SDK deadline; renewals skip configuration and
discovery when the workspace is unchanged. State waits run outside the discovery lock and
are cancelled before shutdown joins the monitor.

Workspace line totals request the `statistics` projection of `git/textDiff`; the backend
returns fresh status and readable-file counts without original/modified text or inline ranges.
Content consumers retain the default full projection. HEAD objects are resolved in bounded
batches per operation, without caching mutable index or worktree contents between requests.

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
