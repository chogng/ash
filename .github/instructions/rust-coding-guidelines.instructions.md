---
description: Ash Rust coding guidelines — style, types, APIs, dependency ownership, and measured build costs.
applyTo: "**/*.rs,**/Cargo.toml,Cargo.toml,Cargo.lock,.cargo/**,justfile,scripts/dependencies.py,scripts/benchmark.py,scripts/test_dependencies.py,scripts/test_benchmark.py,.github/workflows/rust-build-health.yml"
---

# Rust Coding Guidelines

Reference: [Codex Rust guidance](../../../codex/AGENTS.md). Ash ownership, dependency, and validation rules remain authoritative.

## Naming and JSON contracts

| Surface | Convention |
| --- | --- |
| Rust files, modules, functions, variables, and fields | `snake_case` |
| Rust types, traits, and enum variants | `PascalCase` |
| Rust constants and statics | `SCREAMING_SNAKE_CASE` |
| Model declarations, catalog metadata, model lists, and preference-update JSON fields | `snake_case` |
| TypeScript business fields | `camelCase`, converted by the frontend adapter |

- Rust identifiers and serialized JSON names are separate contracts. Parameter values retain their declared spelling, such as reasoning effort `extraHigh` and provider tier ID `priority`.
- Extend naming conventions one complete interface contract at a time. Other existing interfaces, persisted formats, and external provider payloads follow their owning contracts. A JSON rename must update callers, validation, serialization tests, generated schemas and client types, documentation, and affected protocol or storage versions together. See the [model contract scope](../../ash-rs/protocol/README.md#modelsjson-从哪里定义).

## Formatting and control flow

- Inline variables in format strings when possible: `format!("{value}")`.
- Collapse nested `if` statements when their conditions can be combined clearly.
- Prefer method references over closures that only call the same method.
- Make `match` exhaustive for closed enums; avoid wildcard arms that hide newly added variants.

## Types and APIs

- Newly added traits include doc comments explaining their role and how implementations use them.
- Avoid boolean and ambiguous `Option` parameters. Prefer enums, named methods, or newtypes.
- Use enums for closed business states, error codes, and modes; keep variant-specific data on the corresponding variant.
- Generate protocol schemas and client types from the owning Rust definitions; do not maintain duplicate protocol value lists or edit generated files.
- For statically dispatched async traits, prefer RPITIT methods with explicit future bounds, including `Send` when required; do not suppress `async_fn_in_trait` to leave the future contract implicit.
- Default modules and implementation details to private and explicitly re-export the public crate API.
- Prefer one Rust import per line over brace-grouped imports.
- Use file-based module roots: `foo.rs` and `foo/bar.rs`. Do not introduce `mod.rs`.

Test layout, validation commands, warning gates, and protocol regeneration are defined in [Rust testing guidelines](rust-testing.instructions.md).

## Dependencies and build costs

- First-party members of the root Cargo workspace inherit third-party dependency versions and sources from `[workspace.dependencies]`. This includes normal, build, dev, and target-specific dependencies, and vendored third-party paths. Internal workspace path dependencies may remain explicit. Do not apply this policy to separate upstream workspaces or copied third-party manifests.
- Keep dependency features at the consumer that needs them; shared defaults must be required by every inheriting consumer. Keep test-only and build-only dependencies in their own sections. Pin Git dependencies to a commit with `rev`.
- Deliberately coexisting SDK API versions use explicit version aliases in the root manifest. Do not silently upgrade platform APIs while centralizing declarations. For example, `windows-sys-052 = { package = "windows-sys", version = "0.52" }` is inherited by its consumer; it is not a member-local version override.
- Run `just dependencies` after dependency, feature, or lockfile changes. `.cargo/dependencies.toml` records exact reviewed multiple-version sets and their introducing dependencies. Review additions, substitutions, and removed/stale entries; never regenerate this policy solely to make CI pass. `cargo tree -d` is a report, not a failing gate.
- Follow the repository's ownership direction through indirect dependencies too. Shared backend crates must not depend on app UI or CLI/TUI hosts; the daemon must not depend on App Server. Do not import an entire product implementation to obtain a small type or utility. Crates isolate capabilities and dependencies; splitting solely to increase crate count is not a design goal.
- Large generic functions and macro expansions should share substantial type-independent work. Decide from instantiation count, body size, and measured compiler hotspots, not runtime call frequency. Do not mechanically outline every generic method, replace derives, add dynamic dispatch, or add allocations without validating behavior and runtime cost.
- Profile changes require measurements using the actual product/package, toolchain, target, features, and cache conditions. Report clean-target, unchanged, and incremental results separately, together with memory and artifact sizes. Preserve the current unwind constraints. Cargo defaults, source complexity, and LLVM IR counts alone do not establish a speedup.
- Build-performance work must deliver a measured product/code improvement or a measured rejection of a proposed optimization. Adding rules, CI checks, or a benchmark runner alone does not complete the optimization; report implementation and measurement status separately.
- `just bench-build` records reproducible package measurements; its touch scenario measures a source-timestamp rebuild, not a representative implementation edit. Use a controlled real edit for a claim about feature-edit iteration. See [build commands and measurement limits](../../docs/build.md#rust-依赖检查与构建测量).
- Every main-branch push CI compares the protocol package against the previous revision on the same runner and toolchain, using three samples; later pushes do not cancel an unfinished comparison. A slowdown exceeding both 25% and two seconds fails the gate. Inspect the uploaded before/after reports and repeat noisy runs; do not increase the threshold solely to pass a change.

## Learnings

* 不要按 `state` / `view` 机械拆分小型 Rust 组件。只有子模块拥有独立职责、生命周期或依赖边界时才拆分；否则让同名组件文件直接承载状态、行为和绘制逻辑，避免只含模块声明与重新导出的空壳文件。
* 合并或退场 Rust 模块后，必须同步删除旧模块声明、更新调用方、测试和文档，并在交付中明确列出旧路径对应的新归属；看到 IDE 旧标签页报错时，先确认文件是否已退场，再判断是否为编译问题。
* Cargo package 可以保留产品前缀；消费方 dependency key、Rust crate 路径、类型和函数使用最短且不歧义的名称，不把 package 前缀重复带入实现正文。
