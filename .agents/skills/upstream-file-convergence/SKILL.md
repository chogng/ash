---
name: upstream-file-convergence
description: Explicit-only workflow for refactoring or retiring project files by aligning local ownership, callers, tests, and documentation. Use only when the user explicitly invokes $upstream-file-convergence; never activate it from task similarity or editor context.
---

# Upstream File Convergence

Run this workflow only when the current user request explicitly invokes `$upstream-file-convergence`. Do not activate it automatically because a request mentions refactoring, restructuring, consolidation, retirement, file removal, VS Code, Codex, or a path that appears related. Editor context and earlier turns do not count as invocation.

After explicit invocation, use this skill when the user asks to refactor, restructure, consolidate, “重构”, “收掉”, “退场”, retire, or remove a TypeScript or Rust file or responsibility that should converge with its upstream implementation. If the prompt says “this path”, “under this directory”, or equivalent, include the supplied path and all descendants; resolve that scope for the current task instead of hardcoding a path from an earlier task.

## Reference routing

| Target | Reference repository | Typical root |
| --- | --- | --- |
| TypeScript (`.ts`, `.tsx`) | VS Code | `../vscode` |
| Rust (`.rs`) | Codex | `../codex` |

For a mixed TypeScript and Rust change, route each target file independently. Do not infer an upstream repository for other file types without explicit repository evidence or user direction.

## Upstream access boundary

- Do not start, open, search, or inspect `../vscode` or `../codex` during the default workflow.
- Access an upstream repository only when the current user request explicitly asks to look at that repository, such as “看 vscode” or “看 codex”.
- Without that explicit request, use evidence from the current repository only. Do not claim that the result was compared with upstream, and do not block solely because upstream evidence is unavailable.
- When the user explicitly requests one upstream repository, inspect only the repository relevant to the target language; do not access the other repository unless the user asks for it too.

## Outcome

The local implementation has one canonical owner, and all callers, tests, build metadata, and current architecture documentation point to that owner. When upstream inspection was explicitly requested, the owner also corresponds to the relevant upstream responsibility. When the user asked for retirement, remove the original file; when the user asked only for refactoring, preserve files that still have a legitimate responsibility.

## Workflow

1. Resolve the target file from the user's path or active editor context. If the target is ambiguous, ask before editing.
2. Read the repository's `AGENTS.md`, root instructions, and every scoped instruction matching the target and any file that will receive moved responsibility. Preserve unrelated working-tree changes.
3. If the current user request explicitly asks to inspect VS Code or Codex, select the reference repository from the target language and inspect the matching upstream responsibility by exports, callers, lifecycle and ownership role, side effects, and neighboring modules. Otherwise, skip upstream access and establish ownership from local evidence. Do not edit an upstream tree unless the user explicitly asks for a cross-repository change.
4. Locate the local counterpart semantically; a matching basename alone is insufficient. When upstream inspection was explicitly requested, use established mappings such as `src/vs/...` to `app-ts/src/ash/...` when repository evidence supports them. For Rust, derive the mapping from Codex crate and module responsibilities rather than VS Code layout. Without upstream inspection, derive the counterpart from local ownership, callers, tests, and documentation.
5. Merge the target's concrete responsibility into the local counterpart. Preserve local APIs and project-specific behavior unless the requested alignment requires a change; keep dependency direction and the counterpart's existing ownership intact. Do not copy unrelated upstream code or create a speculative abstraction.
6. Update imports, exports, tests, generated or build manifests, and documentation that name the old module or describe its old ownership. For retirement, remove the old file only after a repository-wide search shows no required references remain; do not leave a compatibility shim unless an explicit external contract requires one. For refactoring, keep or rename the old file only when it still owns a distinct responsibility.
7. Verify the result with a repository-wide stale-reference search, the smallest relevant checks and tests, and a focused diff and status review. Report pre-existing failures separately from failures introduced by the change.

## Decision boundaries

- Compare responsibilities, not just filenames. If upstream inspection was explicitly requested and the selected upstream has no safe local counterpart, or two local files plausibly own the same responsibility, stop and explain the evidence instead of guessing.
- Treat “this path” as prompt-time scope: use the nearest explicit path in the request, or the active file's containing directory when the IDE context clearly supplies it, and include descendants. Never turn that resolved example into a permanent skill-specific path.
- The selected upstream tree is a reference for ownership and correspondence, not authorization to broaden the change or overwrite local behavior.
- Keep the change inside the current project and follow its `AGENTS.md` boundaries.
- A retired file may have a dedicated behavior test retained under its feature name; move the test only when doing so improves the canonical ownership boundary without reducing coverage.

## Learnings

* 收敛项目文件时，必须先按语言选择参考仓库：TypeScript 对照 `../vscode`，Rust 对照 `../codex`；不得因为当前技能名称含 VS Code 就把 Rust 实现映射到 VS Code。
