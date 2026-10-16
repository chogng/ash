# Tree-sitter resources

Rust and the browser use the same versioned parsers and query files. WASM assets are built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

## java

- Upstream: [tree-sitter/tree-sitter-java](https://github.com/tree-sitter/tree-sitter-java)
- Revision: `94703d5a6bed02b98e438d7cad1136c01a60ba2c`
- Published source: `tree-sitter-java@0.23.5`
- Source archive SHA-256: `0aa6cbcdc8c679b214e616fd3300da67da0e492e066df01bcf5a5921a71e90d6`
- Highlight query: [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-java/blob/94703d5a6bed02b98e438d7cad1136c01a60ba2c/queries/highlights.scm)
- Local highlight query: [java.scm](java.scm)
- WASM: [java.wasm](../tree-sitter/java.wasm)
- License: [java.LICENSE.txt](java.LICENSE.txt)

Ash-authored tags and folds select declarations and multiline blocks from these grammars. No language server is bundled by these packages.
