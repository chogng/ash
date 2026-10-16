# Tree-sitter resources

Rust and the browser use the same versioned parsers and query files. WASM assets are prepared from the pinned Ash grammar release.

## dotenv

- Upstream: [pnx/tree-sitter-dotenv](https://github.com/pnx/tree-sitter-dotenv)
- Revision: `7f56948e1ce094c400be9a0a7973a063b329f86f`
- Published source: `tree-sitter-dotenv@1.1.2`
- Highlight query: [queries/highlights.scm](https://github.com/pnx/tree-sitter-dotenv/blob/7f56948e1ce094c400be9a0a7973a063b329f86f/queries/highlights.scm)
- Local highlight query: [dotenv.scm](dotenv.scm)
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [dotenv.LICENSE.txt](dotenv.LICENSE.txt)

Ash-authored tags and folds select declarations and multiline blocks from these grammars. No language server is bundled by these packages.
