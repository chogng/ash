# Rust TUI UX Persistence

Use this reference only for UX data interpreted by the Rust TUI under `ash-code`.

## Artifact routing

| Data | Canonical target |
| --- | --- |
| Bounded TUI settings | The `[tui]` table in profile `config.toml` |
| User keybindings | The ordered `[tui].keybindings` value |
| Ordered status-line preferences | The `[tui].statusLine` value |
| User theme selection | The `[tui]` theme setting |
| User theme contents | Strict schema-validated JSON files under `<profile>/code/themes` |
| Session focus, selection, draft, scroll, or overlay state | TUI runtime state, not `[tui]` |

The Rust TUI owns field meanings, defaults, typed decoding, and validation of the complete owned candidate. A persistence service may persist and revision-check the full `[tui]` value, but it treats its contents as opaque and preserves unknown sibling keys.

`[tui]` belongs to the profile beside the Rust TUI process. If the TUI itself runs on another machine, it uses the profile on that machine. Switching the backend connection without moving the TUI process does not switch `[tui]` profiles.

## Eligible setting families

Theme selection, terminal presentation controlled by the TUI, input mode, mouse interaction, follow-up handling, accessibility presentation, keybindings, status-line composition, and other bounded TUI preferences may use `[tui]` when the Rust TUI owns and consumes the behavior. This is an eligibility list, not an implementation claim; require a concrete consumer and typed contract for every field.

Terminal capabilities detected from the host, current focus, selection, drafts, overlays, scroll positions, and session directories remain runtime state. Permissions, providers, execution behavior, and backend configuration do not become UX settings merely because the TUI exposes an editor for them; an existing misplaced field is migration debt rather than precedent.

`add-dir` is a Session operation. The added directory and the capability set granted to it live only for that Session. `[tui].dirPermissions` is not a canonical UX setting: migrate it out rather than using it as a persistent default for future grants. Persisting a complete directory capability set requires a separate explicit action owned by the root permission domain; it is never an implicit side effect of `add-dir`.

## Settings and ordered values

Decode the full `[tui]` candidate before applying it and preserve unknown sibling keys when editing one known field. Bounded ordered values stay inside `[tui]` when they share its revision and settings UI lifecycle.

Compile all keybinding rules against the TUI command catalog and context grammar before replacing active rules. Component-local editing and navigation keys are runtime interaction contracts, not automatically user-configurable application keybindings. Invalid updates keep the previous valid runtime rules and produce a visible diagnostic.

Validate `statusLine` order, item identity, duplicates, separators, and unsupported items as one candidate before applying it. Theme selection and theme contents remain separate; TUI theme files do not consume GUI theme tokens or schemas.

## Migration

- Move TUI UX settings from legacy `configuration.json`, a GUI section, or an older TUI path into `[tui]` only when their meanings are unchanged.
- Migrate older `[tui].keybindings` schemas and command identifiers through the TUI keybinding owner; do not copy TypeScript or Rust GUI bindings.
- Migrate older TUI theme schemas and paths through the TUI theme loader, independently of `[tui].theme`.
- Do not persist session directories, focus, selection, drafts, or scroll position as TUI configuration.
