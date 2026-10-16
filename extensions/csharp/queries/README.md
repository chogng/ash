# Tree-sitter resources

Rust and the browser use the same versioned parsers and query files. WASM assets are prepared from the pinned Ash grammar release.

## csharp

- Upstream: [tree-sitter/tree-sitter-c-sharp](https://github.com/tree-sitter/tree-sitter-c-sharp)
- Revision: `cac6d5fb595f5811a076336682d5d595ac1c9e85`
- Published source: `tree-sitter-c-sharp@0.23.5`
- Source archive SHA-256: `c1aac67f1ad71de1d6d39708d34811081c26dfa495658de6c14c34200849357c`
- Highlight query: [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-c-sharp/blob/cac6d5fb595f5811a076336682d5d595ac1c9e85/queries/highlights.scm)
- Local highlight query: [csharp.scm](csharp.scm)
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [csharp.LICENSE.txt](csharp.LICENSE.txt)

Ash-authored tags and folds select declarations and multiline blocks from these grammars. No language server is bundled by these packages.
