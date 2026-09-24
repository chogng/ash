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

## UUIDs

`uuid.ts` supplies validated UUID values. Domain-specific identifiers should be
introduced with the model that owns their lifecycle rather than being embedded
in the URI utilities.
