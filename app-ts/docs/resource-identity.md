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

| Path | Responsibility |
| --- | --- |
| `environment.ts` | Runtime environment facts shared by Base and Platform |
| `jsonValue.ts` | General JSON value validation |
| `icon.ts`, `lxicons.ts`, `lxiconsLibrary.ts`, `lxiconsUtil.ts`, `productIcons.ts` | Ash icon contracts and generated product icon catalog |

`workbench/services/git/browser/gitService.ts` was also confirmed as the owner
of Ash Git repository selection. Its URI containment check uses the Base
contract; repository discovery and selection remain in that service.

## UUIDs

`uuid.ts` supplies validated UUID values. Domain-specific identifiers should be
introduced with the model that owns their lifecycle rather than being embedded
in the URI utilities.
