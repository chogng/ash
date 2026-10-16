# Tree-sitter resources

Rust and the browser use the same versioned parsers and query files. WASM assets are built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

## batch

- Upstream: [wharflab/tree-sitter-batch](https://github.com/wharflab/tree-sitter-batch)
- Revision: `b5ebbfd167ee4bf8b8ff39d883f9db031a6898f4`
- Published source: `tree-sitter-batch@0.11.1`
- Source archive SHA-256: `46fea9ee100103c3d5fc3c8243da6e8f95163657486040503b8514c9952b79da`
- Highlight query: [queries/highlights.scm](https://github.com/wharflab/tree-sitter-batch/blob/b5ebbfd167ee4bf8b8ff39d883f9db031a6898f4/queries/highlights.scm)
- Local highlight query: [batch.scm](batch.scm)
- WASM: [batch.wasm](../tree-sitter/batch.wasm)
- License: [batch.LICENSE.txt](batch.LICENSE.txt)

The pseudo-variable case-insensitive regex uses explicit character classes so the Rust and JavaScript query runtimes agree.

Ash-authored tags and folds select declarations and multiline blocks from these grammars. No language server is bundled by these packages.
