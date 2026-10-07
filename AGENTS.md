# Ash Agent Instructions

## Before editing

1. Read [`.github/copilot-instructions.md`](.github/copilot-instructions.md) completely for repository ownership, dependency direction, workflow, and scoped-instruction routing.
2. Read every file under [`.github/instructions`](.github/instructions) whose `applyTo` pattern matches any target file. Scoped instructions add to the repository instructions and cannot override a higher-level ownership or safety rule.
3. For any code change, follow the [testing guidelines](.github/instructions/testing.instructions.md), even when no test file changes. Review affected test coverage and validate the affected behavior and build.
4. For Rust, Cargo manifests or lockfiles, `.cargo/`, or Rust build checks, also read the [Rust coding guidelines](.github/instructions/rust-coding-guidelines.instructions.md) and [Rust testing guidelines](.github/instructions/rust-testing.instructions.md).

## Architecture

These principles apply to both Rust and TypeScript. Design for Ash's intended long-term architecture, consider effects across the system, and preserve the repository's ownership and dependency rules.

- Give each piece of business state one clear owning object or module. Keep its update rules there; avoid separate authoritative copies that must synchronize with each other.
- Make clear when configuration changes take effect and who ends tasks and releases resources.
- Keep the main flow from input through execution to saving results easy to follow, including cancellation and failure handling.
- Before splitting a file or adding an interface layer, explain what it is responsible for and which complexity it reduces. File size alone does not justify a split.
- Give the same core business operation the same behavior across clients, with client code following the established domain contracts.

## Implementation

- Do not add fallback paths, transitional designs, or defensive programming.
- Do not use `native` or `projection` in names. Do not introduce `mod.rs`; replace it with a file-based module root when changing the affected module.
- Comment on design reasons, key constraints, lifetimes, and interface contracts that cannot be inferred from the code. Avoid comments that merely restate the code.
- Use Playwright to test Web and Electron behavior. Debug through runtime behavior and assertions, not screenshots.
- Skills constrain code changes. Fix code that conflicts with a Skill; do not rewrite the Skill to fit the implementation. If a Skill appears wrong, explain the issue to the user and change it only when explicitly requested.

## Communication

- Use plain, concrete language. Lead with the conclusion and explain only important boundaries or caveats.
- Prefer compact tables when comparing responsibilities, capabilities, implementation status, or design options.
- Use `✅` and `❌` only for binary judgments. Describe partial progress, unfinished work, coordination, or delegation explicitly.

Reference checkouts: `../vscode`, `../codex`, `../zed`, `../warp`, `../marketplace`, `../mxc`, `../tgrep`.
