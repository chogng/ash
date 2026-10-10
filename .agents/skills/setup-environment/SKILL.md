---
name: setup-environment
description: Set up or repair an Ash checkout on macOS, Windows, Linux, or a cloud worker using repository-pinned tools and dependencies, then verify the requested frontend, backend, or Desktop scope.
---

# Set up Ash

Prepare the selected Ash checkout and verify the requested development scope. This skill configures the machine executing it; committing it does not create a saved cloud environment. Keep the existing `.agents/skills/setup-environment` entrypoint. Run all example commands from the selected repository root; resolve relative paths there.

## Inspect before installing

1. Read `AGENTS.md`, [repository instructions](../../../.github/copilot-instructions.md), matching scoped instructions, [build guidance](../../../docs/build.md), and [frontend guidance](../../../docs/frontend.md) when relevant. Record the checkout path, commit SHA, OS, architecture, requested scope, and initial `git status --short`. Preserve unrelated changes.
2. Resolve commands from the current [justfile](../../../justfile), [package scripts](../../../package.json), and their implementations. Documentation can contain retired paths or aliases; for example, the LiveKit resolver is [build/lib/livekit.py](../../../build/lib/livekit.py). Do not copy VS Code's Gulp setup, lockfiles, or build commands into Ash.
3. Inventory only tools needed for the chosen scope. Report required value, detected value, source, and installed/missing/unverified status. Reuse compatible tools, version managers, virtual environments, and verified caches. Check known executable locations before declaring a tool missing; avoid broad filesystem scans and environment dumps.

Read versions on every run; do not maintain another version list in this skill or a bootstrap script:

| Input | Authority and use |
| --- | --- |
| Rust | [rust-toolchain.toml](../../../rust-toolchain.toml): channel, profile, and components. Inspect `rustup toolchain list` before running a command that might implicitly install a toolchain. |
| Node | [.nvmrc](../../../.nvmrc) for direct Node execution; `engines` and `devEngines.runtime` in root `package.json` for package-script execution. Compare them and stop on contradictions. |
| pnpm | Root `package.json` → `packageManager`; confirm the actual executable version. Ash's preinstall rejects a different package manager/version. |
| Python | [scripts/pyproject.toml](../../../scripts/pyproject.toml) → `requires-python`; verify the chosen interpreter and `import tomllib`. |
| uv | [scripts/pyproject.toml](../../../scripts/pyproject.toml) → `tool.uv.required-version`; confirm `uv --version` matches. |
| Python tools | [scripts/pyproject.toml](../../../scripts/pyproject.toml) declares dependencies; [scripts/uv.lock](../../../scripts/uv.lock) locks their versions and hashes. [scripts/install_python_tools.py](../../../scripts/install_python_tools.py) syncs with `--locked` and binary distributions only. |
| Other build/runtime inputs | Owning build code, `third_party/*/runtime-lock.json`, and [.devcontainer/Dockerfile](../../../.devcontainer/Dockerfile) for the Linux reference package set. Install a host tool only when the selected execution path needs it. |

Git is needed to inspect the checkout. Just is needed for the repository wrappers. Do not install optional Bazel, signing tools, GPU/media tools, or product sandbox services for a frontend-only task.

## Preflight resources and permissions

Check CPU availability (including worker/container quotas), physical/available memory, swap or memory pressure, and free space on both the checkout/output filesystem and tool-cache filesystem. Use ordinary OS observations: macOS `sysctl`, `memory_pressure -Q`, `vm_stat`, `df`, and a short `iostat` sample; Linux `nproc`, `/proc/meminfo`, cgroup limits, `df`, and available disk metrics; Windows CIM CPU/memory queries and `Get-PSDrive`. Explain unavailable observations. A short sample is not a capacity guarantee.

Cold Cargo/V8/media builds and a second worktree can consume substantial disk and memory. Check other active builds and the execution queue before starting them. Run heavy Cargo, package preparation, and Electron acceptance sequentially when resources are shared. Set `CARGO_BUILD_JOBS` only in the invoked process to a conservative count compatible with its CPU/memory budget; respect an existing lower limit. Keep the repository Playwright worker count. Do not raise concurrency merely to match all logical cores.

Use process-local PATH and interpreter overrides. Preserve shell profiles, user tool configuration, compiler flags, proxy settings, and existing `CARGO_TARGET_DIR`. Report a blocked installation or missing privilege with the exact action needed; do not bypass permission checks, alter ACLs/setuid permissions, or install privileged services. Do not record credentials in the skill, scripts, logs, or environment files. [`.codex/environments/environment.toml`](../../../.codex/environments/environment.toml) is generated by Codex: use a supported environment tool if requested and available, never hand-edit it or claim a saved environment was created without confirmation.

## Install only missing inputs

Execute authorized setup in small stages, verifying each stage before proceeding. When setup is already complete, skip the matching installation. If an executable is present but incompatible, prefer the existing version manager with a process-local selection rather than replacing a user's global default.

- **macOS:** inspect the selected Xcode Command Line Tools/compiler (`xcode-select -p`, `xcrun --find clang`). Reuse Homebrew if installed for missing tools; do not install Homebrew just to bootstrap Ash. Full backend preparation builds the locked LiveKit source on macOS and needs the Go requirement enforced by `build/lib/livekit.py` plus the system C/C++ toolchain. Read that requirement instead of copying its version here.
- **Windows:** use the target architecture's Visual Studio Developer PowerShell with MSVC, Windows SDK, and the English tool language pack described in `docs/build.md`. Confirm `pwsh` supports the Just Windows shell. Reuse installed Build Tools; install missing components through the existing installer or `winget`. Resolve Python with `python`/`py`, and pass the selected executable explicitly if needed. Locate LLVM/libclang and set `LIBCLANG_PATH` only for the build process when required; do not set global `CC`/`CXX`. Windows validation must run on Windows.
- **Linux/cloud:** identify the distribution and package manager before installing OS packages. Use the current `.devcontainer/Dockerfile` to identify libraries for the selected scope, including compiler/build tools, ALSA, SSL, libcap, and desktop libraries when needed. Chromium dependencies must match the locked Playwright version. A headless worker can verify Web; Electron requires a display/session or an existing Xvfb setup plus its runtime libraries. Missing kernel namespaces, sandbox support, or privileges are blockers, not reasons to disable isolation.
- **Existing Dev Container:** inspect `.devcontainer/devcontainer.json`, Dockerfile, and `post-create.sh` before using it. Its lifecycle changes ownership and Electron helper permissions and enables privileged mode; do not run `post-create.sh` directly on a host or silently reproduce those actions in a cloud worker. Reuse an already provisioned container's tools and mounted caches. Creating/changing that container requires authorization covering its privileges.

For Node and pnpm, reuse an installed version manager or the documented pnpm standalone installer with the version read from `packageManager`. Inspect any installer for profile/global changes before executing it. Do not use an unpinned `pnpm dlx`, global npm install, or assume Corepack is installed. pnpm's `devEngines.runtime` can provide the pinned Node for scripts; separately verify direct `node` matches `.nvmrc` when it is used.

For Rust, install only the missing channel/components from `rust-toolchain.toml` through rustup. Fetch needed workspace dependencies with `cargo fetch --locked`; subsequent builds use Ash's wrappers so protocol and checksum-locked V8/Sherpa inputs are prepared correctly. Do not switch to direct Cargo builds/tests to work around preparation.

For Python, install the required uv version and run `just install-python` with the inspected bootstrap interpreter, for example `just --set python /absolute/path/to/python install-python`. The installer syncs `scripts/.venv` from the committed lock with `--locked`, reusing a compatible environment. It retains the selected interpreter and does not download Python or build dependencies from source. Do not update the lock or add ad hoc pip requirements to hide a setup failure. If an existing environment uses an incompatible interpreter or is broken, report it and repair within the authorized scope; do not delete it automatically. Afterward, Just selects `scripts/.venv`; Node's [build/python.ts](../../../build/python.ts) also uses it unless a process-local `PYTHON` explicitly overrides it.

Install JavaScript workspace dependencies with `pnpm install --frozen-lockfile`. The install can build Electron-related dependencies even for Web; check compiler/runtime prerequisites and resource cost first. Retain [pnpm-workspace.yaml](../../../pnpm-workspace.yaml) build-approval rules. Do not enable all dependency builds, skip integrity checks, or update lockfiles to hide a setup failure. Install the locked Chromium only when browser acceptance needs it: `pnpm exec playwright install chromium`. On Linux, inspect missing OS libraries before the privileged `install-deps` action.

## Select and verify the scope

Follow the user's requested target. For an unspecified headless cloud worker, start with frontend readiness and state that backend/Desktop acceptance remains separate; a request for the full environment must continue through the relevant full tier. Read the current scripts and their `pre*` hooks before execution: even frontend hooks can invoke Rust to generate the protocol on a fresh checkout. A matching verified protocol cache/package may avoid that compilation; do not fabricate generated files or symlink another dirty checkout's outputs.

| Tier | Preparation and acceptance | Claim allowed after success |
| --- | --- | --- |
| Frontend/Web | `pnpm typecheck:renderer`; `pnpm build:web`; `pnpm test:smoke:browser:no-compile` after compiling `test/automation/tsconfig.json` through `pnpm exec tsc -p test/automation/tsconfig.json`, or use `pnpm test:smoke:browser` to perform its preparation automatically. Launch with `pnpm dev:web` only if requested. | Renderer compiles and the disconnected Web product works; no backend connection claim. |
| Backend/CLI | `cargo fetch --locked`, `just install-python`, then the requested package's `just verify <package>` and actual owning build (for Code, `just build-code`). Complete backend package preparation uses `just ash-package`. | Only the checked/built package or assembled backend scope; a small utility test does not prove a full backend works. |
| Full Web | `pnpm typecheck:renderer` and `pnpm test:smoke:browser:full` (its hooks build Web and prepare the packaged-Node backend). Launch with `pnpm dev:web:full` only if requested. | Full Web/backend behavior covered by the passing Playwright selection. |
| Desktop | `pnpm typecheck:renderer` and `pnpm test:smoke:desktop` (its hooks prepare the backend, build Electron, and compile automation). Launch with `pnpm dev` only if requested. `pnpm test:smoke:ui` covers the UI without full backend acceptance. | Desktop/backend behavior covered on the executing OS; no claim for untested OSes. |

For a setup smoke check, select existing scenarios under [test/smoke/areas](../../../test/smoke/areas) appropriate to the tier; use the package script's file/filter arguments and report them. Confirm the selection ran at least one applicable test and inspect skips. Use DOM/state, connection events, process logs, and assertions; screenshots alone do not verify readiness. Use the existing [Rust validation](../rust-development/SKILL.md#validation) and [TypeScript validation](../../../.github/instructions/typescript-testing.instructions.md) for any accompanying code changes. Whole-workspace tests are not a default setup step.

A safe planning pass can run `just --dry-run install-python` and `just verify ash-utils-home-dir --plan` without compiling or installing. `--plan`/dry-run only validates command resolution; it is not build or runtime acceptance. Do not invoke an installer, lifecycle hook, or backend resolver under a made-up dry-run flag.

## Reentry, failures, and handoff

On rerun, inspect current versions, lockfiles, cache validity, and completed tier results before repeating work. Keep dependency stores, `.build/cargo`, protocol artifacts, and `third_party/.cache` under their existing owners; let repository preparation validate checksums and publish reusable results. Reuse the same profile/features and output layout. Do not automatically run `pnpm clean`, Cargo cache pruning, store deletion, `git clean/reset/stash`, or permission changes. Cache cleanup is a separate requested operation after stopping affected processes.

If a stage fails, identify whether it is a missing input, unsupported platform, network/privilege limit, or existing repository failure. Apply a specific correction and retry only that stage; stop repeating an unchanged failing command. On a permission or download failure, stop the affected stage and report the required access or unavailable source; do not bypass access controls, disable integrity checks, or substitute an unverified mirror. Preserve diagnostic evidence without secrets. Stop only processes started by this setup; use their owned handles/PIDs and await exit. Tests use repository fixtures and isolated profiles; do not launch against the user's live Ash profile to verify setup.

Report checkout/SHA, resolved versions and sources, installed or reused inputs, process-local overrides, commands/exit codes, tests executed/skipped, remaining blockers, and stopped or intentionally running processes. Review final `git status` for unexpected generated or lockfile changes. Do not update README/CONTRIBUTING or tool configuration as a routine final step; propose or make only a specifically authorized correction supported by evidence. Distinguish dependency readiness, build success, running-product checks, and saved-cloud-environment creation.
