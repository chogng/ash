# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## yaml

- Upstream: [tree-sitter-grammars/tree-sitter-yaml](https://github.com/tree-sitter-grammars/tree-sitter-yaml)
- Revision: `7708026449bed86239b1cd5bce6e3c34dbca6415`
- Grammar version: `0.7.2`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [yaml.LICENSE.txt](yaml.LICENSE.txt)

| Local file           | Upstream source                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [yaml.scm](yaml.scm) | [queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-yaml/blob/7708026449bed86239b1cd5bce6e3c34dbca6415/queries/highlights.scm) |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
