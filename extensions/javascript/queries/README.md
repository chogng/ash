# Tree-sitter resources

- Upstream: [tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript)
- Grammar version: `0.25.0`; revision: `44c892e0be055ac465d5eeddae6d3e194424e7de`
- Rust uses the locked `tree-sitter-javascript` dependency. The Web Worker uses the existing
  `@vscode/tree-sitter-wasm` parser assets.
- Highlight capture names are adapted to Ash's editor theme vocabulary. TypeScript
  composes the JavaScript base queries; TSX also composes the JSX query.
- Adjacent `*.LICENSE.txt` files retain the upstream MIT licenses.

| Local file                                 | Upstream source                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [javascript.scm](javascript.scm)           | [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-javascript/blob/44c892e0be055ac465d5eeddae6d3e194424e7de/queries/highlights.scm)         |
| [javascript.tags.scm](javascript.tags.scm) | [queries/tags.scm](https://github.com/tree-sitter/tree-sitter-javascript/blob/44c892e0be055ac465d5eeddae6d3e194424e7de/queries/tags.scm)                     |
| [jsx.scm](jsx.scm)                         | [queries/highlights-jsx.scm](https://github.com/tree-sitter/tree-sitter-javascript/blob/44c892e0be055ac465d5eeddae6d3e194424e7de/queries/highlights-jsx.scm) |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
