# Tree-sitter resources

- Upstream: [tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript)
- Grammar version: `0.23.2`; revision: `f975a621f4e7f532fe322e13c4f79495e0a7b2e7`
- Rust uses the locked `tree-sitter-typescript` dependency. The Web Worker uses the existing
  `@vscode/tree-sitter-wasm` parser assets.
- Highlight capture names are adapted to Ash's editor theme vocabulary. TypeScript
  composes the JavaScript base queries; TSX also composes the JSX query.
- Adjacent `*.LICENSE.txt` files retain the upstream MIT licenses.

| Local file                                 | Upstream source                                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [typescript.scm](typescript.scm)           | [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-typescript/blob/f975a621f4e7f532fe322e13c4f79495e0a7b2e7/queries/highlights.scm) |
| [typescript.tags.scm](typescript.tags.scm) | [queries/tags.scm](https://github.com/tree-sitter/tree-sitter-typescript/blob/f975a621f4e7f532fe322e13c4f79495e0a7b2e7/queries/tags.scm)             |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
