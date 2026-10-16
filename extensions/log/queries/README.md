# Tree-sitter resources

Rust and browser hosts use these same parser sources and queries. WASM assets are built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

- Upstream: [Tudyx/tree-sitter-log](https://github.com/Tudyx/tree-sitter-log)
- Revision: `62cfe307e942af3417171243b599cc7deac5eab9`
- Source: `tree-sitter-log@0.0.1`
- Highlight source: [queries/highlights.scm](https://github.com/Tudyx/tree-sitter-log/blob/62cfe307e942af3417171243b599cc7deac5eab9/queries/highlights.scm)
- WASM: [log.wasm](../tree-sitter/log.wasm)
- Licenses: [log.LICENSE-MIT.txt](log.LICENSE-MIT.txt)

The upstream Cargo binding targets an older Tree-sitter API. Its pinned parser uses a package-local binding; Ash-authored highlight captures use the shared theme vocabulary. Log lines do not supply declaration or structural-fold queries.

Whitespace is normalized in copied parser sources. No language server is bundled by this package.
