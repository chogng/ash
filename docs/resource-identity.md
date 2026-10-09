# Resource identity

Ash keeps the resource foundation small and aligned with the roles used in VS
Code:

- `uri.ts` represents URI values.
- `resources.ts` provides URI identity rules.
- `map.ts` provides `ResourceMap` and `ResourceSet`.

`resourceTree.ts` is a separate hierarchical path data structure. It should be
added when a file explorer, SCM view, or another real tree consumer needs it,
not as part of basic URI identity.

## Comparison contract

`ResourceMap` uses the exact serialized URI by default, including query and
fragment. This is the least surprising general-purpose behavior.

Registries that intentionally treat different URI fragments as the same
resource can pass `extUri.getComparisonKeyIgnoringFragment` as their map key
function.

Path casing is a policy decision. The default policy treats local `file:` paths
as written. `extUriBiasedIgnorePathCase` follows the current native platform,
and remote providers can create an `ExtUri` matching their own semantics.

File-backed frontend owners use `IUriIdentityService` from
`platform/uriIdentity/common/uriIdentity.ts`. It selects comparison semantics
from the registered provider's `PathCaseSensitive` capability or directory-scoped facts and establishes
canonical document URIs while retaining query and the caller's fragment.
Providers without a registered scheme retain case-sensitive comparison.
Canonicalization normalizes encoded path segments without resolving symlinks
or granting filesystem access.

`FileService` publishes provider registration and capability changes. The
identity service invalidates that scheme's bounded spelling cache immediately;
open models and working copies retain their own lifetimes. File models reject
new acquisition when a changed policy matches multiple existing models, so
edited documents are never silently merged.

Local disk providers use the host's default casing policy; IndexedDB, browser
folder handles and settings resources preserve case. App Server filesystem
providers query `fs/readPathCaseSensitivity` with the owning directory ID (or
Session directory) and relative path before opening editors or acquiring file
models. Rust owns the filesystem observations and BrowseFiles authorization;
TypeScript owns URI comparisons, canonical spelling, tabs and model lifetimes.

The response lists existing directory ancestors in order, starting at `.`.
Each scope's `sensitive`, `insensitive` or `unknown` rule applies only to its
direct children. A sensitive parent remains distinct even when both child
directories are insensitive. Missing destinations are allowed; unconfirmed
components preserve their spelling. Confirmed insensitive scopes fold ASCII
letters; Unicode case variants remain distinct because sensitivity alone does
not specify the filesystem's folding table. Queries use granted directory handles and
never create probe files; the spelling of ancestors outside that grant is
preserved. macOS uses `fpathconf`, Windows queries
`FileCaseSensitiveInfo`, and Linux checks directory casefold flags on supported
filesystems. Unsupported filesystem observations return `unknown`.

Each granted root retains at most 4096 transient directory rules and 4096
memoized requests. Models, editor tabs, working copies, save recovery and retained
undo histories hold explicit identity references; their required ancestor rules
remain available until those owners release them. Transient cache eviction cannot
change an active resource's comparison rules.

Connection changes and workspace replacement discard observations and requests;
late responses from an old lifetime are cancelled. File events retire earlier
queries for the affected root while retaining facts until explicit preparation
refreshes them. A shorter response removes rules below the first unconfirmed
component, and changed parent rules invalidate dependent descendant keys. Unknown
rules continue to preserve spelling. Identity notifications invalidate canonical
spelling without publishing file-content changes or reloading unrelated models.
Cancelling an acquisition stops that caller's wait; the shared read-only query may finish.
Same-product schema compatibility remains enforced by initialization, so an
incompatible server is rejected rather than treated as an unknown filesystem.
Remote identity must not be inferred from the renderer OS.

`ExtUri.isEqualOrParent(base, parentCandidate)` checks directory boundaries
under the same path casing policy. Scheme, authority, query, and fragment must
match; callers can explicitly ignore the fragment. Git repository selection
compares paths without query or fragment because those components describe a
file view, not the repository location.

## Alignment ownership

The `base/common` directory currently has 61 matching implementation files,
seven Ash-only files, and 92 implementation paths present only in VS Code.
VS Code also has three declaration files absent from Ash. There are no case-only
path differences. Missing paths enter implementation only when an Ash
production caller reaches their responsibility.

The following seven Ash-only paths were confirmed on 2026-09-25 to retain
their current responsibilities:

| Path                                                                              | Responsibility                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `environment.ts`                                                                  | Runtime environment facts shared by Base and Platform |
| `jsonValue.ts`                                                                    | General JSON value validation                         |
| `icon.ts`, `lxicons.ts`, `lxiconsLibrary.ts`, `lxiconsUtil.ts`, `productIcons.ts` | Ash icon contracts and generated product icon catalog |

`workbench/contrib/git/browser/gitService.ts` was also confirmed as the owner
of Ash Git repository selection. Its URI containment check uses the Base
contract; repository discovery and selection remain in that service.

## UUIDs

`uuid.ts` supplies validated UUID values. Domain-specific identifiers should be
introduced with the model that owns their lifecycle rather than being embedded
in the URI utilities.
