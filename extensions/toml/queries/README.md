# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## toml

- Upstream: [tree-sitter-grammars/tree-sitter-toml](https://github.com/tree-sitter-grammars/tree-sitter-toml)
- Revision: `64b56832c2cffe41758f28e05c756a3a98d16f41`
- Grammar version: `0.7.0`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [toml.LICENSE.txt](toml.LICENSE.txt)

| Local file           | Upstream source                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [toml.scm](toml.scm) | [queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-toml/blob/64b56832c2cffe41758f28e05c756a3a98d16f41/queries/highlights.scm) |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
