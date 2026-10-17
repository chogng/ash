# Plugin utilities

`ash-utils-plugins` owns shared plugin IDs and their serialization validation, `.ash-plugin`
marker discovery and manifest location, exact `PluginSkillRoot` descriptors and stable Skill
source naming, Plugin MCP routing names, and plaintext `$` / `@` mention sigils.

Package authorities supply normalized declarations and verified immutable roots. This crate has
no install, enablement, grant, activation, credential or runtime state. `ash-plugin` owns full
manifest and package validation; `ash-core-plugins` resolves effective package contributions;
Skills, Connectors, MCP and TUI consume these common contracts. App Server only composes the
package and runtime owners.

The structure follows Codex's `utils/plugins` with Ash's existing identities and package format.
Discovery remains bounded to the source root and direct children. Foreign manifest parsers,
recursive Skill discovery and command migration are not introduced by this extraction.
