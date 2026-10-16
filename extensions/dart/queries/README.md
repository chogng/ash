# Tree-sitter resources

Rust and browser hosts use these same parser sources and queries. WASM assets are built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

- Upstream: [nielsenko/tree-sitter-dart](https://github.com/nielsenko/tree-sitter-dart)
- Revision: `b57d734c84f510bbd524097902cab671e4dbfca9`
- Source: `tree-sitter-dart@0.2.0`
- Source archive SHA-256: `325dd1e24ee9ee21111e9c43680ae7d6010aaa9f282b048a99b9c7163c1cf553`
- Highlight source: [queries/highlights.scm](https://github.com/nielsenko/tree-sitter-dart/blob/b57d734c84f510bbd524097902cab671e4dbfca9/queries/highlights.scm)
- WASM: [dart.wasm](../tree-sitter/dart.wasm)
- Licenses: [dart.LICENSE.txt](dart.LICENSE.txt)

Whitespace is normalized in copied queries. Ash-authored tags and folds select declarations and multiline blocks. No language server is bundled by this package.
