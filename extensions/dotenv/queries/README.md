# Tree-sitter resources

Rust and the browser use the same versioned parsers and query files. WASM assets are built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

## dotenv

- Upstream: [pnx/tree-sitter-dotenv](https://github.com/pnx/tree-sitter-dotenv)
- Revision: `7f56948e1ce094c400be9a0a7973a063b329f86f`
- Published source: `tree-sitter-dotenv@1.1.2` (package-local Rust binding)
- Highlight query: [queries/highlights.scm](https://github.com/pnx/tree-sitter-dotenv/blob/7f56948e1ce094c400be9a0a7973a063b329f86f/queries/highlights.scm)
- Local highlight query: [dotenv.scm](dotenv.scm)
- WASM: [dotenv.wasm](../tree-sitter/dotenv.wasm)
- License: [dotenv.LICENSE.txt](dotenv.LICENSE.txt)

Ash-authored tags and folds select declarations and multiline blocks from these grammars. No language server is bundled by these packages.
