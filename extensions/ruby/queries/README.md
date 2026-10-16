# Tree-sitter resources

Rust and browser hosts use these same parser sources and queries. WASM assets are prepared from the pinned Ash grammar release.

- Upstream: [tree-sitter/tree-sitter-ruby](https://github.com/tree-sitter/tree-sitter-ruby)
- Revision: `71bd32fb7607035768799732addba884a37a6210`
- Source: `tree-sitter-ruby@0.23.1`
- Source archive SHA-256: `be0484ea4ef6bb9c575b4fdabde7e31340a8d2dbc7d52b321ac83da703249f95`
- Highlight source: [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-ruby/blob/71bd32fb7607035768799732addba884a37a6210/queries/highlights.scm)
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- Licenses: [ruby.LICENSE.txt](ruby.LICENSE.txt)

The scope-dependent catch-all method capture is omitted; identifiers keep their variable capture unless a call or declaration identifies a method. ERB templates remain outside this source-language package.

Whitespace is normalized in copied queries. Ash-authored tags and folds select declarations and multiline blocks. No language server is bundled by this package.
