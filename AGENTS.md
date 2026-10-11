# Ash Agent Instructions

Read [`.github/instructions`](.github/instructions) files whose `applyTo` matches the edited path.

## Repository ownership

| Path | Owner |
| --- | --- |
| `crates/` except terminal presentation | Shared backend domains and infrastructure |
| `src/` | Electron Desktop and Browser Workbench product host |
| `crates/tui/` | `ash code` Ratatui presentation, host-terminal and color-capability detection |
| `cli/` | User-facing `ash` command, management operations and terminal launch |
| `crates/app-server` | Listening entrypoints, service registries, queue execution and automation |
| `crates/app-server-daemon` | Daemon lifecycle; manages a separate `ash-app-server --managed` process |
| `crates/remote-connections` | Local Remote management |
| `crates/remote-server` | Remote runtime |
| `crates/arg0` | Shared internal helper dispatch |

- Electron and Browser hosts must not execute, package, import or depend on the `cli/` product host, `ash-tui`, or the `ash app-server` product command.
- Keep the runtime dependency direction `app-server → app-server-daemon`, never the reverse.

## Common rules

- In `AGENTS.md`, instructions and skills, keep concrete actions, prohibitions and necessary exceptions in one place. Delete duplicated rules, skill triggers or documentation indexes, and prose that adds no constraint.
- Do not keep competing copies of business state; update it through its owning model or service.
- Product consumers use domain contracts, not generated transport DTOs.
- Do not add placeholder modules or public APIs without a caller. Export only symbols used by another module or an external contract.
- Do not split Rust files solely to reduce line count.
- Validate inputs at user, configuration, plugin, persistence, process, worker, IPC, RPC and network boundaries. Do not revalidate typed same-process values already normalized by their owning boundary.
- Do not use `native` or `projection` in names.
- Comments explain reasons, constraints, lifetimes or API rules that are not evident from code.
- Use the client's NLS for changed product-owned user-visible text, including accessibility text; update translations and verify at least one non-default language. Parameterize dynamic text; do not translate command IDs, protocol fields, paths or user content.
- If the requested UI style conflicts with an applicable skill, ask the user before implementing it.
- Use `✅` and `❌` only for binary judgments.

## Development workflow

- Do not generate staged workflow records unless the user explicitly invokes `/develop`.
- Modify the requested checkout; do not substitute another checkout or only a remote branch. Preserve unrelated changes.
- A PR is optional for repository-owner changes; use PR review for external contributions or security-sensitive changes.
