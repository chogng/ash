# Tree-sitter resources

- Upstream: [tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust)
- Grammar version: `0.24.2`; revision: `e2bee853694a1d3e0f6ef308fe3674542fec95d7`
- Rust uses the locked `tree-sitter-rust` dependency. The Web Worker uses the existing
  `@vscode/tree-sitter-wasm` parser assets.
- Highlight capture names are adapted to Ash's editor theme vocabulary. TypeScript
  composes the JavaScript base queries; TSX also composes the JSX query.
- Adjacent `*.LICENSE.txt` files retain the upstream MIT licenses.

| Local file                     | Upstream source                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [rust.scm](rust.scm)           | [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-rust/blob/e2bee853694a1d3e0f6ef308fe3674542fec95d7/queries/highlights.scm) |
| [rust.tags.scm](rust.tags.scm) | [queries/tags.scm](https://github.com/tree-sitter/tree-sitter-rust/blob/e2bee853694a1d3e0f6ef308fe3674542fec95d7/queries/tags.scm)             |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
