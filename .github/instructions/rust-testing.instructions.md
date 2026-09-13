---
description: Ash Rust package testing, warning, conditional-compilation, protocol-generation, and product validation rules.
applyTo: "**/*.rs,**/Cargo.toml,Cargo.toml,Cargo.lock,.cargo/**,justfile,scripts/cargo.py,scripts/dependencies.py,scripts/benchmark.py,scripts/test_dependencies.py,scripts/test_benchmark.py,.github/workflows/rust-build-health.yml"
---

# Rust Testing Guidelines

Read `testing.instructions.md` first. This file adds Rust-specific commands and coverage requirements.

## Package validation

- Do not run `cargo check` or `cargo test` directly for routine validation. Use `just check <crate> [args]` and `just test <crate> [args]`; these commands select a package and configure the locked V8 files only when its dependency graph needs them.
- Start with the package that owns the changed behavior. A test-name filter does not limit workspace compilation, so always select a package and never run bare `cargo test <filter>` from the workspace root.
- After the package check and affected tests pass, run `just rust-warnings <crate>`; it compiles every package target and denies compiler warnings. Fix the cause instead of adding an `allow` solely to pass the gate.
- Ask the user before running a complete workspace check or test suite. Escalate only after targeted validation passes and the change affects a shared workspace contract, or when the user explicitly requests full coverage.
- Do not add `--workspace`, `--all-targets`, or `--all-features` as routine validation expansion. Use package-scoped target or feature expansion only when the changed surface specifically requires it; combining expansion with a workspace-wide run requires the same explicit approval as a complete suite.
- Keep one incremental setting throughout a validation round. After a failure rerun only the failed test or target; switching artifact modes or rebuilding whole packages creates avoidable duplicate outputs and disk pressure.

## Tests and conditional compilation

- Dependency changes must pass `just dependencies`, affected package checks, and their warning gates. Preserve feature activation and validate affected build/package manifests; declaration cleanup alone does not prove build equivalence.
- Changes to dependency checks or measurement tooling must pass `just test-python scripts` and execute the changed command against the real workspace. Dependency checks inspect metadata without compiling the workspace and do not require a full-suite escalation.

- Test-only code must live in a sibling test file whenever the implementation can expose the required private surface to its own test module. Do not add production methods solely to make tests convenient.
- A test-only helper's `cfg` must match every condition shared by all of its callers. For example, a helper used only by a `#![cfg(unix)]` test module uses `#[cfg(all(test, unix))]`, not `#[cfg(test)]`.
- When platform conditions change, compile the owning package's test targets on every affected platform. A successful check on one operating system does not prove another operating system's `cfg` graph.

## Generated contracts

- After changing an App Server protocol type or registry entry, run `just generate-protocol`, the protocol package tests, the generated TypeScript strict check, and the affected client build or typecheck.
- Generated fixtures and bindings are outputs, not independent sources. Update their owner and regenerate them instead of editing generated files directly.

## Rust app validation

- Assert state, commands, semantic identity, events, timing, output, and PTY lifecycle. Do not use screenshots or pixels as pass/fail evidence.
- Validate the running product with `just app`, `python -B scripts/cargo.py run -p app`, or the built executable. Use `APP_SESSION_TRACE=1`; add `APP_SESSION_TRACE_FRAMES=1` only for frame timing.

## Learnings

* 性能对照复用 Cargo 输出并回切源码时，不能只复制保留旧时间戳的文件；必须使选定源码重新变脏，并从 Cargo timings 或 fresh 标记确认实际重编译。把不同内容误判为 Fresh 的运行不能计入性能结果。

* cargo-shear 不能可靠识别跨 crate 的 `#[path]` 测试支持文件。删除依赖前检查这些引用，并编译受影响包的全部测试目标；仅由共享测试支持使用的依赖放入 dev-dependencies，误报只在所属包记录，并注明真实引用文件。

* Existing test-only helpers must use the same effective `cfg` as all callers; a broader `#[cfg(test)]` can compile dead code on platforms where the caller module is absent. Run the owning package's warning gate after test changes so platform-specific stale helpers fail validation.
