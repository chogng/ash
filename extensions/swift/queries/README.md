# Tree-sitter resources

Rust and browser hosts use these same parser sources and queries. WASM assets are prepared from the pinned Ash grammar release.

- Upstream: [alex-pinkus/tree-sitter-swift](https://github.com/alex-pinkus/tree-sitter-swift)
- Revision: `b8b22bffbb3441780e6471665bacfb263741c86a`
- Source: `tree-sitter-swift@0.7.3`
- Source archive SHA-256: `fe36052155b9dd69ca82b3b8f1b4ccfb2d867125ac1a4db1dd7331829242668c`
- Highlight source: [queries/highlights.scm](https://github.com/alex-pinkus/tree-sitter-swift/blob/b8b22bffbb3441780e6471665bacfb263741c86a/queries/highlights.scm)
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- Licenses: [swift.LICENSE.txt](swift.LICENSE.txt)

Whitespace is normalized in copied queries. Ash-authored tags and folds select declarations and multiline blocks. No language server is bundled by this package.

Swift stays on 0.7.3 because 0.7.4 adds scanner allocation diagnostics that import process exit and stdio symbols unavailable in the browser parser runtime. Both hosts use the unmodified 0.7.3 sources.
