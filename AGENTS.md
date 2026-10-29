# Ash Agent Instructions

If need, read the local refers: `../mxc`, `../tgrep`, `../vscode`, `../codex`, `../zed`, `../warp`, `../livekit`

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
| `remote-server/` | Remote runtime and independent distribution |
| `livekit-server/` | Optional local call hosting distribution |
| `crates/arg0` | Shared internal helper dispatch |

- Electron and Browser hosts must not execute, package, import or depend on the `cli/` product host, `ash-tui`, or the `ash app-server` product command, except to launch an independently installed CLI in the integrated terminal at the user's explicit request. IDE capabilities must still use the shared app-server directly.
- Keep the runtime dependency direction `app-server → app-server-daemon`, never the reverse.

## Common rules

- 只修改任务所需的内容；原文无问题就保留，不顺手重写；非必要不添加引用。
- In `AGENTS.md`, instructions and skills, keep concrete actions, prohibitions and necessary exceptions in one place. Delete duplicated rules, skill triggers or documentation indexes, and prose that adds no constraint.
- Skill 可以基于 `AGENTS.md` 和适用的 instructions，按职责保持独立；仅在任务确实需要组合时引用其他 skill，禁止循环引用。普通文档可以引用 skill，但 skill 不得依赖普通文档提供执行规则。通用约束放在 instructions，专项执行流程放在 skill，避免重复维护。
- Do not keep competing copies of business state; update it through its owning model or service.
- Product consumers use domain contracts, not generated transport DTOs.
- TypeScript frontend service construction, registration and scope ownership must follow the [Dependency Injection contract](.github/instructions/typescript-services.instructions.md#dependency-injection).
- Do not add placeholder modules or public APIs without a caller. Export only symbols used by another module or an external contract.
- Do not split Rust files solely to reduce line count.
- Validate inputs at user, configuration, plugin, persistence, process, worker, IPC, RPC and network boundaries. Do not revalidate typed same-process values already normalized by their owning boundary.
- Write comments to reduce the reader's reasoning burden, especially for contracts, lifetimes, complex logic and design reasons; avoiding useless comments does not mean writing fewer comments. Do not merely restate code, and update comments when behavior changes.
- Use the client's NLS for changed product-owned user-visible text, including accessibility text; update translations and verify at least one non-default language. Parameterize dynamic text; do not translate command IDs, protocol fields, paths or user content.
- If the requested UI style conflicts with an applicable skill, ask the user before implementing it.
- Use `✅` and `❌` only for binary judgments.

## Development workflow

- Do not generate staged workflow records unless the user explicitly invokes `/develop`.
- 能在当前授权范围内完成的工作，应持续执行并验证，不得用写 TODO 代替收尾。只有本轮确实无法完成、需要交接时，才在根目录 TODO.md 记录进展、剩余步骤及具体阻塞；完成后移除对应条目，不为已完成工作或可选后续建议新增 TODO。
- Modify the requested checkout; do not substitute another checkout or only a remote branch. Preserve unrelated changes.
- Run self-hosting validation through Ash itself.
- Before committing or publishing, run `just commit-check <base-ref>` and handle its result as defined in the [commit workflow](.agents/skills/commit-pr/SKILL.md#prepare-the-exact-change). CI checks the full repository.
- A PR is optional for repository-owner changes; use PR review for external contributions or security-sensitive changes.
