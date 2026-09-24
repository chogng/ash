# ash-commands

`ash-commands` owns the stable command vocabulary shared by Workbench command entry points.

## Responsibilities

- `AppCommandId` is the type-safe identity used by Rust callers; `AppCommandId::ALL` is the complete catalog and `AppCommandId::BINDABLE` is the subset exposed to user keybindings.
- `AppCommandId::id`, `from_id`, and `bindable_from_id` own the persisted string boundary, including compatibility names under `workbench.action.*`; internal callers do not pass string IDs.
- Command execution, UI element mapping, focus, state changes, and invalidation belong to `ash-workbench`; this crate has no dependency on Workbench state, `zui`, keybinding execution, or domain APIs.

## Execution path

```text
pointer / menu / shortcut / command palette
  → AppCommandId
  → WorkbenchApplication::dispatch_command
  → owning Workbench or domain API
  → invalidation / presentation rebuild
```

The dispatcher in `app-rs/workbench/command.rs` uses an exhaustive `match`, so adding an `AppCommandId` requires adding its execution path at compile time. Commands do not replace direct typed APIs between Workbench and Editor, Terminal, Files, Session, or App Server owners.

## Verification

```bash
just test ash-commands
```
