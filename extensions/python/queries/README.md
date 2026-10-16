# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## python

- Upstream: [tree-sitter/tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python)
- Revision: `293fdc02038ee2bf0e2e206711b69c90ac0d413f`
- Grammar version: `0.25.0`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [python.LICENSE.txt](python.LICENSE.txt)

| Local file                         | Upstream source                                                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [python.scm](python.scm)           | [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-python/blob/293fdc02038ee2bf0e2e206711b69c90ac0d413f/queries/highlights.scm) |
| [python.tags.scm](python.tags.scm) | [queries/tags.scm](https://github.com/tree-sitter/tree-sitter-python/blob/293fdc02038ee2bf0e2e206711b69c90ac0d413f/queries/tags.scm)             |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
