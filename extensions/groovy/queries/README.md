# Tree-sitter resources

Rust and browser hosts use the same pinned parser and composed queries. WASM is built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

- Upstream: [murtaza64/tree-sitter-groovy](https://github.com/murtaza64/tree-sitter-groovy)
- Revision: `2a6ddd558b6aa39c5b77d8db9fe9baf817486b2c`
- Source: `tree-sitter-groovy@0.0.1`
- License: [groovy.LICENSE.txt](groovy.LICENSE.txt)
- WASM: [groovy.wasm](../tree-sitter/groovy.wasm)

The Git dependency and browser parser use the same unmodified revision. Highlights retain upstream capture names. This grammar supports Groovy dynamic parameters and Gradle/Jenkins closure syntax.

Whitespace is normalized in copied resources. Ash-authored tags and folds select declarations and multiline blocks. No language server is bundled by this package.
