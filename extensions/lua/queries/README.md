# Tree-sitter resources

Rust and browser hosts use these same parser sources and queries. WASM assets are built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

- Upstream: [tree-sitter-grammars/tree-sitter-lua](https://github.com/tree-sitter-grammars/tree-sitter-lua)
- Revision: `10fe0054734eec83049514ea2e718b2a56acd0c9`
- Source: `tree-sitter-lua@0.5.0`
- Source archive SHA-256: `8daaf5f4235188a58603c39760d5fa5d4b920d36a299c934adddae757f32a10c`
- Highlight source: [queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-lua/blob/10fe0054734eec83049514ea2e718b2a56acd0c9/queries/highlights.scm)
- WASM: [lua.wasm](../tree-sitter/lua.wasm)
- Licenses: [lua.LICENSE.md.txt](lua.LICENSE.md.txt)

Whitespace is normalized in copied queries. Ash-authored tags and folds select declarations and multiline blocks. No language server is bundled by this package.
