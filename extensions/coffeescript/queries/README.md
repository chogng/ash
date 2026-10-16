# Tree-sitter resources

Rust and browser hosts use the same pinned parser and composed queries. WASM is built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

- Upstream: [svkozak/tree-sitter-coffeescript](https://github.com/svkozak/tree-sitter-coffeescript)
- Revision: `3bb4dbd68ca926c76b3baadb529da4de3726ea37`
- Source: `tree-sitter-coffeescript@0.0.1`
- License: [coffeescript.LICENSE.txt](coffeescript.LICENSE.txt)
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)

The upstream binding targets Tree-sitter 0.20; a local LanguageFn binding serves the same parser in Rust and WASM. Ash maintains these compatibility fixes in the package-owned grammar and scanner:

- File-level CSON pairs and quoted keys.
- Statement separators remain ambiguous until a following statement or trailing newline resolves them.
- Inline arrow/method bodies end at a physical newline. Switch clauses use indentation, and catch clauses accept unparenthesized bindings.
- Dedents close their blocks before publishing the separating newline. Comments before a block's first statement do not introduce another separator.
- Scanner state is bounded by Tree-sitter's serialization buffer, with invalid serialized state reset before reuse.

Whitespace is normalized in copied resources. Ash-authored tags and folds select declarations and multiline blocks. Literate and mixed-language templates remain separate modes; no language server is bundled by this package.

The shared corpus in `test/fixtures/tree-sitter/coffeescript.json` contains 28 upstream-derived examples and 13 Ash regressions. All 41 sources compile with the official CoffeeScript 2.7.0 compiler; its version and npm integrity are recorded in the fixture. Eight upstream examples required syntax corrections before validation, and retain their original input in `upstreamSource`. Top-level statement counts come from the compiler AST, excluding zero-width comment placeholders.

Rust and WASM tests require every source to parse without errors. WASM tests also check statement boundaries after edits and undo, incomplete-input recovery, and the scanner's nesting budget. The regressions cover LF/CRLF, missing final newlines, comments, blank lines, nested dedents, tabs, and inline bodies.

Regenerate parser.c, grammar.json, and node-types.json with Tree-sitter CLI 0.26.3 by running `tree-sitter generate` from this package's `tree-sitter/coffeescript` Cargo directory. Rebuild WASM with `node build/treeSitter.ts --build coffeescript` from the repository root.
