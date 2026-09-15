# Rust GUI UX Persistence

Use this reference only for UX data interpreted by the Rust GUI under `app`.

## Artifact routing

| Data | Canonical target |
| --- | --- |
| Bounded GUI settings | The `[gui]` table in profile `config.toml` |
| User keybindings | The ordered `[gui].keybindings` value |
| User theme selection | The `[gui]` theme setting |
| User theme contents | Strict schema-validated JSON files in the profile `app/themes` directory |
| Reconstructable window or view state | The GUI state store, not `[gui]` |

The Rust GUI owns field meanings, defaults, typed decoding, and validation of the complete owned candidate. A persistence service may persist and revision-check the full `[gui]` value, but it treats its contents as opaque and preserves unknown sibling keys.

`[gui]` belongs to the profile beside the Rust GUI process. Its owner does not change when the GUI connects to another backend; a remote setting needs its own explicit scope and contract.

## Eligible setting families

Appearance selection, interface and editor typography, density, accessibility preferences, input behavior, editor presentation, workbench layout policy, notification presentation, keybindings, and other bounded GUI preferences may use `[gui]` when the Rust GUI owns and consumes the behavior. This is an eligibility list, not an implementation claim; require a concrete consumer and typed contract for every field.

Current window geometry, pane sizes, active tabs, expanded sections, selections, and scroll positions remain GUI state. Permissions, providers, execution behavior, session data, and backend configuration do not become `[gui]` fields merely because the GUI edits them.

## Settings and ordered values

Decode the full `[gui]` candidate before applying it and preserve unknown sibling keys when editing one known field. Use a nested TOML value for bounded ordered data such as keybindings when it shares the GUI settings revision and editor lifecycle. Do not create a separate file without an independent resource lifecycle.

Compile all keybinding rules against the Rust GUI command catalog and context grammar before replacing active rules. Invalid updates keep the previous valid runtime rules and produce a visible diagnostic; persistence errors do not mutate the active snapshot.

Theme selection and theme contents remain separate. `[gui]` stores the selected theme identity; the theme loader owns the JSON schema, token validation, file limits, and resource diagnostics.

The Rust GUI owns its theme catalog, defaults, schema, and resource directory independently of the TypeScript UI. Shared visual guidance does not create a shared theme file contract or a build dependency between UI hosts.

## Migration

- Move Rust GUI UX values from `[desktop]`, an older GUI section, or an older profile path into `[gui]` only when their meanings are unchanged.
- Migrate older `[gui].keybindings` schemas and command identifiers through the Rust GUI keybinding owner; do not copy TypeScript or TUI bindings.
- Migrate older GUI theme schemas and paths through the GUI theme loader, independently of `[gui].theme`.
- Leave backend configuration and worktree-provided intent with their existing owners.
