# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## diff

- Upstream: [tree-sitter-grammars/tree-sitter-diff](https://github.com/tree-sitter-grammars/tree-sitter-diff)
- Revision: `4867e8470e1b0ad7364c4e3ffab762c361bbb635`
- Grammar version: `0.1.0`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [diff.LICENSE.txt](diff.LICENSE.txt)

| Local file                                 | Upstream source                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [diff.scm](diff.scm)                       | [queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-diff/blob/4867e8470e1b0ad7364c4e3ffab762c361bbb635/queries/highlights.scm) |
| [diff.injections.scm](diff.injections.scm) | [queries/injections.scm](https://github.com/tree-sitter-grammars/tree-sitter-diff/blob/4867e8470e1b0ad7364c4e3ffab762c361bbb635/queries/injections.scm) |

`diff.injections.scm` is adapted to the pinned 0.1.0 grammar by omitting the newer
`special`, `change` and `unrecognized` nodes. Change markers are excluded from embedded parsing.

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
