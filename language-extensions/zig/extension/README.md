# Zig syntax

The package contributes the `.zig` association, language
configuration and Tree-sitter highlighting, outline and folding queries.

Build a standalone submission for the signed Extensions registry with
`pnpm package:declarative language-extensions/zig/extension .build/packages/zig`.
A standalone Git repository with `.ash-plugin/plugin.json` at its root can also
be installed through **Install extension from Git repository** in the IDE. For
local development, install and enable the `language-extensions/zig` directory
as a plug-in.

The grammar comes from the [ash-grammars v0.1.2 Wasm release](https://github.com/chogng/ash-grammars/releases/tag/v0.1.2).
It uses upstream Tree-sitter Zig revision `6479aa13f32f701c383083d8b28360ebd682fb7d`.
The uncompressed `zig.wasm` SHA-256 is
`2c72fafe91037948aa4c7dfb950b5627cf462868421fb60c1808506d4733b51e`.
The grammar license is included in this package.
