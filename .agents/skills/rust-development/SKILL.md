---
name: rust-development
description: Implement and validate Ash Rust code, Cargo manifests or lockfiles, .cargo settings, and Rust build tools. Use for Rust changes across ash-rs, app-rs, code, and ash-cli. Does not apply to TypeScript-only work or ordinary documentation edits.
---

# Rust development

Find the owning Cargo package and read its implementation and tests before editing. Use `just context <file>` to find applicable instructions. Keep product ownership as defined in [repository instructions](../../../.github/copilot-instructions.md); workspace membership does not change it.

## Code

- Use enums for closed states, errors, and modes, with data on the matching variant. Avoid ambiguous boolean or `Option` parameters. Match closed enums without wildcard arms.
- Add doc comments to new traits. For static async dispatch, prefer methods returning `impl Future` with explicit bounds, including `Send` when needed. Do not silence `async_fn_in_trait`.
- Use one import per line. Package names may keep product prefixes; avoid repeating them in code.
- Keep small components together. Split for different responsibilities, resource lifetimes, or dependencies. When moving or removing modules, update declarations, callers, tests, and docs together; report where moved code belongs.
- Put test-only code in sibling test files when possible. Do not add production methods for tests. Match helpers' `cfg` to their callers.

## Contracts

For model or provider fields, follow [model-provider-fields](../model-provider-fields/SKILL.md). Model JSON uses `snake_case`; frontend adapters use `camelCase`. Preserve parameter spellings and other formats' rules; see [model naming](../../../ash-rs/protocol/README.md#modelsjson-从哪里定义).

Rename JSON fields together with callers, validation, serialization tests, generated types, docs, and affected protocol or storage versions. Generate schemas, fixtures, and bindings from their source definitions. Do not hand-edit generated files or duplicate protocol values.

## Dependencies

- Root-workspace crates inherit third-party dependencies from `[workspace.dependencies]`; internal paths may stay explicit. Leave upstream workspaces and copied third-party manifests alone.
- Enable features where used. Shared defaults must serve every consumer. Use `dev-dependencies` for tests and `build-dependencies` for build scripts. Pin Git dependencies with `rev`.
- Declare intentional SDK version differences through root aliases. Do not silently upgrade them.
- Review added and removed versions in `.cargo/dependencies.toml`; do not regenerate it just to pass CI. `cargo tree -d` only reports duplicates. Tool versions and commands are in [dependency checks](../../../docs/build.md#依赖检查).
- Do not import a whole product for one helper. Before removing a dependency, check cross-crate `#[path]` test support; `cargo-shear` can miss it. Compile affected test targets. Document false positives with their real uses in the owning package.

## Validation

Validate the changed package with `just verify <crate>`. For targeted runs, use `just check`, `just test`, and `just rust-warnings` with a package name. Use these wrappers rather than direct Cargo checks or tests. Do not hide warnings with `allow`.

Keep the same profile, features, and incremental settings. Rerun failed steps only. `--plan` does not count as validation. See [development commands](../../../docs/build.md#固定开发步骤).

Ask before checking or testing the whole workspace unless the user already requested it. Expand only after package checks pass and a shared contract changed, or the user requested full coverage. Expand targets and features only when the change requires it.

Add the checks required by the change:

| Change | Additional validation |
| --- | --- |
| Dependencies, features, or lockfile | Run `just dependencies`; check features and affected build/runtime manifests. |
| App Server protocol | Run `just generate-protocol`, protocol tests, `pnpm --dir app-ts typecheck:protocol`, and affected client builds or typechecks. |
| Tests | Run the warning check; test-only code must not create production warnings. |
| Platform conditions | Compile affected test targets on every affected platform. |
| Dependency or build-measurement tools | Run `just test-python scripts` and the changed command against the real workspace. |

For Rust product behavior, verify state, commands, identity, events, output, timing, and PTY lifecycle. For Rust Desktop runtime investigation, use `APP_SESSION_TRACE=1 just app`; enable `APP_SESSION_TRACE_FRAMES=1` only for frame timing. For TUI tests, use [test-tui](../test-tui/SKILL.md); for CLI processes and terminal boundaries, use [test-tui-pty](../test-tui-pty/SKILL.md).

For example, an App Server field rename requires package validation, regeneration, the generated TypeScript strict check, and checks for affected clients. A private implementation change without a contract change stays with the owning package.
