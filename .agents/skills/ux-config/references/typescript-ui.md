# TypeScript UI UX Persistence

Use this reference only for UX data interpreted by the TypeScript UI under `app-ts`.

## Boundary with VS Code API alignment

This reference classifies Ash-specific UX data and decides its semantic owner, artifact kind, and legitimate scopes. It does not independently design the TypeScript configuration infrastructure.

For TypeScript configuration files and APIs that correspond to VS Code, full API alignment owns their paths, public contracts, registration, target resolution, precedence, syntax-aware editing, lifecycle, migration plumbing, and observable behavior. Once that alignment is complete, those mechanics must follow from the aligned configuration system rather than from parallel UX-specific persistence code.

Until full alignment is complete, treat the TypeScript rules below as the target contract, not as evidence that the current implementation already satisfies it. Do not preserve a legacy wrapper, add a fallback path, or introduce a second configuration owner to compensate for an incomplete alignment.

When a setting has a VS Code counterpart, use the counterpart's registered contract, including its scope. For a Ash-specific setting, this skill still decides whether it is configuration at all and which scopes its meaning permits; express that decision through the aligned configuration registry.

Delete this temporary section after a completed alignment audit verifies the configuration paths, public APIs, owners, lifecycle, call paths, and observable behavior. At that point, also remove any rules below that merely restate the aligned TypeScript configuration mechanics; retain only Ash-specific data classification, ownership, artifact-selection, and scope decisions.

## Artifact routing

| Data | Canonical target |
| --- | --- |
| Registered scalar or structured settings | Profile or workspace `settings.json`, parsed as JSONC, with only the scopes registered for that key |
| User keybindings | The profile's dedicated ordered `keybindings.json` resource; do not nest it under ordinary settings |
| User keyboard layout definition | The profile's dedicated schema-validated `keyboard-layout.json` resource |
| User theme selection | A registered setting in `settings.json` |
| User theme contents | A strict schema-validated JSON file in the profile theme resource directory |
| Reconstructable window or workbench state | The TypeScript UI state resource, not settings |

Like VS Code, use the `settings.json` filename with JSONC parsing for contributed keys, layered overrides, comments, and syntax-aware edits. Keep the document as a plain settings object rather than adding a schema-version envelope. A dedicated resource is appropriate when order, full-document validation, independent revisions, or a specialized editor are part of the contract. The filename alone does not decide whether comments are accepted; the parser and serializer must define and preserve the supported syntax.

## Eligible setting families

Appearance selection, accessibility preferences, editor presentation and behavior, keyboard interpretation, workbench layout policy, localization, search presentation, and source-control presentation may use registered settings when the TypeScript UI owns and consumes the behavior. This is an eligibility list, not an implementation claim; require a concrete consumer and registered contract for every setting.

Current tab, pane, selection, scroll, window geometry, recent-item, and cache values remain state. Extension enablement, tasks, launch behavior, permissions, providers, and backend execution settings retain their own domain owners even when surfaced in the TypeScript settings UI.

## Settings contract

Register each key once with its type, default, allowed scopes, schema, parser, and serializer. The registry's allowed scope is authoritative: profile, remote profile, workspace, workspace folder, and language override files may expose only keys valid at that target. Preserve comments, trailing commas, unrelated keys, and override blocks with syntax-aware edits. Reject a value written at an unsupported scope.

Supported scope candidates are profile, remote profile, workspace, workspace folder, and language override. A key receives only the scopes its semantics require.

The local profile follows the TypeScript UI process. A remote profile is a separate declared scope for keys that genuinely describe the remote environment; connecting to a backend does not move ordinary workbench preferences into that backend's profile.

## Ordered resources

Keybindings remain a top-level ordered array with their own command catalog, context expressions, platform overrides, blockers, revision, validation, and change event. Validate the entire candidate before replacing active rules. Preserve the last valid runtime snapshot when an external edit is invalid, while reporting the invalid resource explicitly.

Do not generalize the keybinding file into a container for unrelated UX data. Create another dedicated resource only when it has its own editor, lifecycle, and complete-document contract.

## Migration

- Migrate legacy `configuration.json` values to registered keys in `settings.json`; do not place new settings in the legacy wrapper.
- Keep migration code and any migration receipt outside the plain settings object. Run key migrations at every supported target and make them idempotent; do not add a document-wide version envelope to `settings.json`.
- Keep `keybindings.json` independent while migrating its supported older schema or identifiers in place through a versioned resource migration.
- Migrate older theme schemas and paths through the theme resource owner, separately from theme selection.
- Never move TypeScript presentation settings into Rust `[gui]` merely because both interfaces are graphical.
