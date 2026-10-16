# Tree-sitter resources

Rust and browser hosts use these same parser sources and queries. WASM assets are built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

- Upstream: [tree-sitter/tree-sitter-php](https://github.com/tree-sitter/tree-sitter-php)
- Revision: `58d5643086ae60e93a3746cca648363ee97c8761`
- Source: `tree-sitter-php@0.25.1`
- Source archive SHA-256: `d9779e392d38af4254f48be0e57b7eed4d50ec7a6e55a7e5e2e74df8f8f032d3`
- Highlight source: [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-php/blob/58d5643086ae60e93a3746cca648363ee97c8761/queries/highlights.scm)
- WASM: [php.wasm](../tree-sitter/php.wasm)
- Licenses: [php.LICENSE.txt](php.LICENSE.txt)

The full PHP grammar handles PHP tags and text between them. The upstream text injection query delegates embedded markup to the existing HTML parser.

Whitespace is normalized in copied queries. Ash-authored tags and folds select declarations and multiline blocks. No language server is bundled by this package.
