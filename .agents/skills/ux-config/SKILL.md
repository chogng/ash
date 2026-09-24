---
name: ux-config
description: Decide the owner, scope, artifact, format, precedence, validation, and one-way migration for persistent UX settings and user-editable resources across the TypeScript UI, Rust GUI, and Rust TUI. Use for settings, keybindings, themes, and similar durable UI data, and to route secrets, permissions, backend behavior, and ephemeral state to their actual owners without designing those domains here.
---

# UX Config

Route persistent UX data to one semantic authority and one canonical artifact. A host-owned preference normally has one UI consumer; a shared resource may have multiple consumers only when one schema owner validates the complete artifact for all of them. Cover both ordinary settings and independently editable resources; do not force keybindings, theme contents, and runtime state into a generic settings document.

## Classify the data

| Kind | Examples | Storage decision |
| --- | --- | --- |
| Durable setting | Theme selection, font, density, reduced motion, interaction preference | The owning UI host's settings document or TOML table |
| Ordered user rules | Keybindings | A dedicated ordered resource when it has an independent editor and revision lifecycle; otherwise a typed ordered field in the host table |
| Versioned UX resource | User theme contents | A dedicated strict JSON document with a schema and resource validator |
| Reconstructable UI state | Window geometry, expanded sections, selections, scroll positions, cache | The owning state store or database, not configuration |
| Secret | Credential or token | The secret store |
| Backend intent | Provider, execution, permission, or service behavior | The owning backend domain, outside this skill |

A setting that selects a resource and the resource contents are separate data. For example, theme selection belongs in settings while a user theme belongs in a schema-validated JSON file. Do not create a standalone file merely because a value is complex; require a distinct lifecycle, editor, merge model, or distribution boundary.

If the data does not fit a listed kind, its current location is disputed, or no existing artifact has a complete contract for it, read [references/artifact-selection.md](references/artifact-selection.md) before choosing a host artifact. Treat an existing location as evidence, not as the final architecture; misplaced data is migration debt rather than precedent.

## Route by UI host

Choose the implementation surface before the artifact. Names used in a request may help locate code, but they do not determine ownership.

- For the TypeScript UI under `app-ts`, read [references/typescript-ui.md](references/typescript-ui.md).
- For the Rust GUI under `app`, read [references/rust-gui.md](references/rust-gui.md).
- For the Rust TUI under `ash-code`, read [references/rust-tui.md](references/rust-tui.md).
- If one change intentionally spans multiple UI hosts, read every corresponding reference. Keep host-specific selections and settings independent; share resource contents only when they already have one cross-host schema authority and lifecycle.

Do not read unrelated host references. Do not merge the TypeScript UI and Rust GUI because both render graphical interfaces. Shared keybinding grammar or theme concepts do not imply shared commands, settings keys, files, or resource schemas.

## Define the contract

Before implementation, state:

- the UI host that interprets the data;
- whether it is a setting, ordered rule resource, versioned resource, state, secret, or backend intent;
- whether its locality follows the UI process, a remote environment, a directory, or a Session;
- supported scopes and precedence;
- canonical artifact and format;
- schema, defaults, parser, serializer, and complete-value validator;
- revision, external-edit, and conflict behavior;
- legacy source and one-way migration when an older representation exists.

Give each value one persisted source and one interpretation path. A generic persistence service may store a complete table or document with revision checks, but it must treat UI-owned fields as opaque and must not define their meanings or defaults.

Use only scopes whose semantics the owner explicitly supports. A profile-wide preference must not become workspace-configurable merely because a storage service supports workspace files. Define precedence only among legitimate scopes, and keep defaults at the interpreting UI host. Do not change a device or UI-process preference's profile merely because the active backend connection changes.

If repository evidence and the applicable references still do not determine the semantic owner, data kind, artifact lifecycle, scope, precedence, or migration mapping, stop before implementation and discuss the unresolved decision with the user. Present the verified facts, the exact ambiguity, the viable choices, and their consequences; do not guess, add a fallback path, or encode an unresolved choice as a new reference.

## Maintain decision guidance

When work establishes a durable UX persistence rule that the skill does not cover, preserve it for later work:

- Update the existing host reference when a new data family maps to an existing artifact or when a host-specific ownership, scope, validation, or migration rule changes.
- Create a focused reference only for a new independent resource kind or a substantial workflow that would otherwise make a host reference hard to use. Link it from `SKILL.md` or the relevant host reference and state exactly when to read it.
- Update [references/artifact-selection.md](references/artifact-selection.md) only when the cross-host decision criteria change.
- Do not create a reference for one setting key, copy source documentation into the skill, or record a current file placement as a rule without verifying its semantic owner.

Keep current implementation facts in their canonical architecture or implementation documents. Skill references contain only reusable decisions that change future configuration work.

## Migrate legacy data

Migrate before normal resolution:

1. Parse and validate the legacy source without modifying it.
2. Map only values whose owner and meaning are unambiguous, then validate the complete target.
3. Write an absent target atomically. If source and target are equal, retain the target. If they differ, report a conflict and leave both unchanged.
4. Remove the legacy value only after the target is durable, and record completion or use a self-identifying transformation so restart is idempotent. Do not force a version field into an artifact whose canonical contract has none.
5. Read and write only the target after migration. Do not dual-write or keep a permanent fallback reader.

Writers emit only the current representation. A legacy decoder needs an explicit legacy-shape detector and removal boundary; versioned resources also require an input version.

## Verify

Verify persisted input, parsing, complete-value validation, precedence, runtime application, external reload, revision conflicts, and error reporting. For ordered resources, also verify order, duplicate/conflict rules, blockers or overrides, and preservation of unrelated entries. For migration, cover legacy-only, target-only, equal source and target, conflicting values, invalid input, interruption before cleanup, idempotent restart, and preserved unrelated data.

Report the chosen UI host, data kind, artifact, scopes, migration source, and checks that actually passed.
