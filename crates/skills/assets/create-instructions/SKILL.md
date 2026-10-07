---
name: create-instructions
description: Create or update Ash instruction files from a requested project rule, convention, or correction in the conversation. Use when the user wants a durable rule for future agent work.
---

# Create instructions

Extract the concrete rule and its reason from the request or conversation. Inspect existing rules before editing them; update the owning rule instead of adding a duplicate. Keep rules concise and specific, with an example when it resolves ambiguity.

Choose the scope from the request. Workspace rules belong to the active authorized directory; personal rules belong to the exact Ash home supplied in the context. Do not guess the home from a shell account or assume `~/.ash` when a different home is configured. If scope is unspecified, use the active workspace; ask only when no destination can be determined.

Use `AGENTS.md` for shared always-on guidance or `ASH.md` for Ash-specific always-on guidance. For a focused rule use `<workspace>/.ash/instructions/<name>.md` or `<ash-home>/instructions/<name>.md`. Names contain lowercase letters, digits, and interior hyphens; the filename stem and `name` must match.

Choose one loading policy:
- `global`: every invocation in the chosen scope.
- `contextual`: automatic loading for relative file `patterns`.
- `on-demand`: explicit file selection or agent reading when its description is relevant.

Example for a file-specific rule:

```markdown
---
name: rust-errors
description: Error handling conventions for Rust code.
load: contextual
patterns:
  - '**/*.rs'
---

Return errors with enough context to identify the failed operation.
```

Omit `patterns` for `global` and `on-demand`. Ash uses `patterns`, not VS Code's `applyTo`. A description supports discovery; it does not make the body always-on.

Use ordinary authorized file tools. Read the completed file back, check its format, and report its path, scope, loading policy, and how to exercise the rule. Creating an instruction does not grant tools or filesystem permissions.
