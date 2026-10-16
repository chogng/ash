# Tree-sitter resources

Rust and the browser use the same versioned parsers and query files. WASM assets are prepared from the pinned Ash grammar release.

## make

- Upstream: [tree-sitter-grammars/tree-sitter-make](https://github.com/tree-sitter-grammars/tree-sitter-make)
- Revision: `5e9e8f8ff3387b0edcaa90f46ddf3629f4cfeb1d`
- Published source: `tree-sitter-make@1.1.1`
- Source archive SHA-256: `c5998dc7cbcbdab19fae8aefef982bf2d6544513d8d2e69cc44aec4c63810104`
- Highlight query: [queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-make/blob/5e9e8f8ff3387b0edcaa90f46ddf3629f4cfeb1d/queries/highlights.scm)
- Local highlight query: [make.scm](make.scm)
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [make.LICENSE.txt](make.LICENSE.txt)

Ash-authored tags and folds select declarations and multiline blocks from these grammars. No language server is bundled by these packages.
