# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## bash

- Upstream: [tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash)
- Revision: `a06c2e4415e9bc0346c6b86d401879ffb44058f7`
- Grammar version: `0.25.1`
- Rust dependency: `tree-sitter-bash`
- WASM: [`../tree-sitter/bash.wasm`](../tree-sitter/bash.wasm)
- License: [bash.LICENSE.txt](bash.LICENSE.txt)

| Local file           | Upstream source                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [bash.scm](bash.scm) | [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-bash/blob/a06c2e4415e9bc0346c6b86d401879ffb44058f7/queries/highlights.scm) |

Ash also captures `string_content` so unfinished quotes retain string styling while typing.

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
