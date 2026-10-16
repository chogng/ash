# Tree-sitter resources

Rust and browser hosts use the same pinned parser and composed queries. WASM is built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

- Upstream: [tree-sitter/tree-sitter-julia](https://github.com/tree-sitter/tree-sitter-julia)
- Revision: `a8e1262997d5a45520a06cbe1b86c0737d507054`
- Source: `tree-sitter-julia@0.23.1`
- Source archive SHA-256: `4144731a178812ee867619b1e98b3b91e54c1652304b26e5ebe3175b701de323`
- License: [julia.LICENSE.txt](julia.LICENSE.txt)
- WASM: [julia.wasm](../tree-sitter/julia.wasm)

The upstream ancestor-dependent begin/end builtin capture is omitted because the shared runtime does not evaluate that custom predicate. Ordinary identifiers retain their normal capture.

Whitespace is normalized in copied resources. Ash-authored tags and folds select declarations and multiline blocks. No language server is bundled by this package.
