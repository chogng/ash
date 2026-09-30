# `ash-collaboration-mode-templates`

This crate owns the default model-facing approach text for Agent, Plan, Debug, Multitask, and Ask modes. App Server selects one template for a new Turn and freezes it alongside the active Agent instructions. The mode text does not grant tools or permissions.

Update the corresponding file under `templates/` when changing a mode's behavior. Mode identity and serialization belong to `ash-protocol`; shared Agent rules belong to `ash-prompts`; role duties and tool limits belong to `ash-agent-roles`.

The five modes, Turn persistence, queue behavior, and delegated worker rules are documented together in [Collaboration modes](../docs/collaboration-modes.md).
