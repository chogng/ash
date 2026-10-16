# Tree-sitter resources

Rust and the browser use the same versioned parsers and query files. WASM assets are prepared from the pinned Ash grammar release.

## c

- Upstream: [tree-sitter/tree-sitter-c](https://github.com/tree-sitter/tree-sitter-c)
- Revision: `b780e47fc780ddc8da13afa35a3f4ed5c157823d`
- Published source: `tree-sitter-c@0.24.2`
- Source archive SHA-256: `a9b2eb57a55fed6b00812912e730b7a275cf4fe98bfd6a5d76263d4438371728`
- Highlight query: [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-c/blob/b780e47fc780ddc8da13afa35a3f4ed5c157823d/queries/highlights.scm)
- Local highlight query: [c.scm](c.scm)
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [c.LICENSE.txt](c.LICENSE.txt)

## cpp

- Upstream: [tree-sitter/tree-sitter-cpp](https://github.com/tree-sitter/tree-sitter-cpp)
- Revision: `f41e1a044c8a84ea9fa8577fdd2eab92ec96de02`
- Published source: `tree-sitter-cpp@0.23.4`
- Source archive SHA-256: `df2196ea9d47b4ab4a31b9297eaa5a5d19a0b121dceb9f118f6790ad0ab94743`
- Highlight query: [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-cpp/blob/f41e1a044c8a84ea9fa8577fdd2eab92ec96de02/queries/highlights.scm)
- Local highlight query: [cpp.scm](cpp.scm)
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [cpp.LICENSE.txt](cpp.LICENSE.txt)

C++ composes the C highlight query before its C++ additions.

Ash-authored tags and folds select declarations and multiline blocks from these grammars. No language server is bundled by these packages.
