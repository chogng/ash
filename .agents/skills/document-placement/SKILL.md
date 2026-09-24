---
name: document-placement
description: Choose documentation placement using project ownership and project-specific rules in Ash. Use when creating architecture documents, technical designs, implementation plans, or engineering proposals, or when the user explicitly requests documentation relocation.
---

# Document Placement

Before choosing a destination, read the [documentation instructions](../../../.github/instructions/documentation.instructions.md) and the scoped instructions for the project that owns the documented capability. The documentation instructions own the general placement rules; project-specific requirements are maintained in the corresponding scoped instructions.

| Document owner | Destination |
| --- | --- |
| TypeScript frontend under `ash-ts/`, including the Ash editor and Workbench | `ash-ts/docs/` |
| Shared Rust backend under `ash-rs/` | `ash-rs/docs/` |
| Desktop product and Rust UI under `app/` | `app/docs/` |
| CLI and TUI product under `ash-code/` | Follow the [CLI/TUI documentation placement rules](../../../.github/instructions/tui.instructions.md); do not create an `ash-code/docs/` tree |
| Repository-wide behavior that genuinely has no single project owner | `docs/` |

For another stable top-level project, use `<project>/docs/` unless its scoped instructions specify a different location. Do not treat an individual crate, package, feature folder, or the currently active file as a project boundary.

Choose the owner from the document's subject and long-term responsibility. When a document crosses projects but one project owns the contract or user-visible behavior, place it with that owner and link to supporting implementation elsewhere. Split the document only when the topics have independent owners and can remain useful independently.

Keep existing documents at their current paths when editing them. Do not migrate, rename, or reorganize existing documentation merely to adopt this rule. A relocation explicitly requested by the user may use the destination rules above.

README files remain beside the implementation they describe; move, rename, or convert them only when the user explicitly requests it. Update affected existing navigation when a requested relocation changes document paths.

If the user explicitly supplies a destination for the current document, follow that request.
