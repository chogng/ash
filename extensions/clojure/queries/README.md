# Tree-sitter resources

Rust and browser hosts use the same pinned parser and composed queries. WASM is built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

- Upstream: [jerielverissimo/tree-sitter-clojure](https://github.com/jerielverissimo/tree-sitter-clojure)
- Revision: `6248a3f3d3c76ec7d33c52e7553761facdcb4ab5`
- Source: `tree-sitter-clojure@0.1.0`
- Source archive SHA-256: `4004884cc509449a1d78fa3e1f02b4e953d0a8065984445304795e72e885338c`
- License: [clojure.LICENSE.txt](clojure.LICENSE.txt)
- WASM: [clojure.wasm](../tree-sitter/clojure.wasm)

The original grammar and queries are CC0. A local LanguageFn binding avoids an unused additional Tree-sitter runtime. Ash adds form-keyword captures.

Whitespace is normalized in copied resources. Ash-authored tags and folds select declarations and multiline blocks. No language server is bundled by this package.
