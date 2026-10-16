# Tree-sitter resources

Rust and browser hosts use the same pinned parser and composed queries. WASM is built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

- Upstream: [ganezdragon/tree-sitter-perl](https://github.com/ganezdragon/tree-sitter-perl)
- Revision: `883ab51150f32583e4f6877a6bf16e9f83b8935f`
- Source: `tree-sitter-perl@1.1.2`
- Source archive SHA-256: `e79d4ae71b42e595c24c354b59905ade8162bd400ebc53ab916ea8aec54da92d`
- License: [perl.LICENSE.txt](perl.LICENSE.txt)
- WASM: [perl.wasm](../tree-sitter/perl.wasm)

The source archive ships no highlight queries. Ash-authored queries cover comments/POD, strings, variables, declarations, numbers, and control flow.

Whitespace is normalized in copied resources. Ash-authored tags and folds select declarations and multiline blocks. No language server is bundled by this package.
