# Ash Repository Instructions

## Quick reference

Before changing a file, identify its owner and read every matching scoped instruction.

| Change surface | Required instruction |
| --- | --- |
| TypeScript frontend | [`coding-guidelines.instructions.md`](instructions/coding-guidelines.instructions.md), [`frontend-architecture.instructions.md`](instructions/frontend-architecture.instructions.md), and [`source-code-organization.instructions.md`](instructions/source-code-organization.instructions.md) |
| Editor implementation | [`editor.instructions.md`](instructions/editor.instructions.md) |
| Browser UI or CSS | [`browser-ui.instructions.md`](instructions/browser-ui.instructions.md) |
| Any implementation or test | [`testing.instructions.md`](instructions/testing.instructions.md) |
| Rust, Cargo manifests/lockfile, `.cargo/`, or Rust build checks | [`rust.instructions.md`](instructions/rust.instructions.md) and [`rust-testing.instructions.md`](instructions/rust-testing.instructions.md) |
| TypeScript tests and validation | [`typescript-testing.instructions.md`](instructions/typescript-testing.instructions.md) |
| `ash-rs/native` or `app` | [`native.instructions.md`](instructions/native.instructions.md) |
| Markdown documentation | [`documentation.instructions.md`](instructions/documentation.instructions.md) |
| `ash-code` CLI/TUI | [`tui.instructions.md`](instructions/tui.instructions.md) |

Scoped instructions contain implementation rules. Architecture documents contain design, status, and rationale.

### Finding Related Code
1. **Semantic search first**: Use file search for general concepts
2. **Grep for exact strings**: Use grep for error messages or specific function names
3. **Follow imports**: Check what files import the problematic module
4. **Check test files**: Often reveal usage patterns and expected behavior


## Repository ownership

Desktop frontend paths below are relative to `ash-ts/`.

| Path | Owner |
| --- | --- |
| `src/ash/base` | Domain-neutral TypeScript utilities and UI primitives |
| `src/ash/platform` | Shared frontend services and platform abstractions |
| `src/ash/editor` | Editor models, state, projection, and contributions |
| `src/ash/workbench` | Application shell, Parts, panes, and product composition |
| `ash-rs` | Shared Rust backend protocols, domains, storage, execution, and backend-neutral server host |
| `app` | Rust Desktop product, including editor text state, file editing lifecycle, terminal emulation, Composer input classification, Shell completion, `zui`, `ash-ui-components`, `ash-workbench-ui`, renderer, `wgpu`, and `winit` |
| `ash-code` | `ash code` CLI and Ratatui product host |

Preserve the frontend dependency direction `base → platform → editor → workbench`. Lower layers must not import, specialize for, or copy state from higher layers. Multiple callers do not justify moving a domain concept into `base`; the abstraction must be domain-neutral and have a complete current consumer contract.

`ash-ts` and `app` must not execute, package, import, or depend on `ash-cli`, `ash-tui`, `ash-code/cli`, or the `ash app-server` product command. App Server listening entrypoints belong to `ash-rs/app-server`; daemon lifecycle commands belong to `ash-rs/app-server-daemon`; local Remote management belongs to `ash-rs/remote-connections`; the remote runtime belongs to `ash-rs/remote-server`. Shared internal helper dispatch belongs to `ash-rs/arg0`. The daemon manages a separate `ash-app-server --managed` process; service registries, queue execution, and automation run in `app-server`. Keep the runtime dependency direction `app-server → app-server-daemon`, never the reverse.

`ash-rs`, `app`, and `ash-code` may remain in the same root Cargo workspace; workspace membership does not change implementation ownership.

When a request mentions Workbench, Sessions, or another frontend concept, locate it in the Renderer/Workbench first. Only route to `ash-code` when the request explicitly concerns the terminal, Ratatui, the CLI, or `ash-code`.

## General implementation rules

- Give state, lifecycle, layout, rendering, persistence, and validation one canonical owner.
- Keep adapters thin and mechanical. Product consumers depend on frontend or backend domain contracts, not generated transport DTOs.
- Reuse an existing abstraction when its contract is complete for the caller. Do not create speculative abstractions, empty placeholder modules, or public APIs without a concrete consumer.
- Register owned disposable resources immediately after creation. A repeated resource must be disposed with the repeated state that owns it.
- Prefer direct dependencies and method calls over hidden service lookup or event chains used as control flow.
- Keep public APIs smaller than implementations. Export only symbols required by another module or a documented external contract.
- Validate at user, configuration, plugin, persistence, process, worker, IPC, RPC, and network boundaries. Trust typed same-process values after the owning boundary has normalized them.

## Cross-system ownership

Workspace owns source scanning, ignore rules, reads, chunking, revision, and chunk identity. A cloud CodeIndex may prepare model input, perform vector retrieval, call rerank, and sort/filter/truncate by model score, but it may consume only exact Workspace-authorized chunks. `model-provider` owns model invocation, not indexing or retrieval policy; cross-source result fusion belongs to retrieval.

Callable Skills use the dedicated `$name` selector, such as `$commit`. Slash Commands remain product or server commands, while `@` remains the selector prefix for files and Plugin-provided context. `/skills` owns browsing, enablement, and diagnostics. Skill lists load metadata only; full `SKILL.md` content loads after selection or automatic activation.

Generic Marketplace infrastructure and templates must not hardcode a repository owner, personal namespace, or product identity. Publisher identity comes from repository configuration; product-specific manifests belong only to optional consumer adapters. Marketplace validation and publication must not require any consuming product source tree or release state.

## Development workflow

- For ordinary tasks, implement the requested behavior, run the relevant tests, and report results directly. Update existing documentation only where behavior or responsibilities changed. The staged artifact workflow in [`docs/development-workflow.md`](../docs/development-workflow.md) applies only when the user explicitly invokes `/develop`.
- Modify the exact repository or worktree the user named. Do not substitute a temporary clone, another worktree, or only a remote branch without explicit agreement.
- In an owner-led pre-release repository, a PR is not the default integration requirement. Use PR review for external contributions, security-sensitive work, or real multi-person review needs.
- Use the smallest typecheck, test, build, or documentation check that covers the changed surface. Rust package commands and workspace escalation are defined by [`rust-testing.instructions.md`](instructions/rust-testing.instructions.md); TypeScript validation is defined by [`typescript-testing.instructions.md`](instructions/typescript-testing.instructions.md). Do not report a command as passing unless it completed successfully.
- Preserve unrelated working-tree changes. A historical violation is migration debt, not precedent for new code.

## Learnings

* 仅在用户显式使用 `/develop` 时生成和维护 intent、spec、plan、verification 及变更登记。普通评估、修复和实现直接完成必要工作与测试，按需更新现有文档，不自动套用阶段产物流程。
* 新增或修改产品自有的用户可见文案时，必须同步接入所属端现有 NLS、更新语言词条，并验证至少一种非默认语言，否则不得宣称功能完成。共享命令描述、参数提示、面板、错误和无障碍文本均适用；动态文案使用可翻译模板与参数，命令标识、协议字段、路径和用户内容不翻译。
