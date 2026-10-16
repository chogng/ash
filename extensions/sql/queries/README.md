# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## sql

- Upstream: [DerekStride/tree-sitter-sql](https://github.com/DerekStride/tree-sitter-sql)
- Revision: `7b51ecda191d36b92f5a90a8d1bc3faef1c7b8b8`
- Grammar version: `0.3.11`
- Rust dependency: `tree-sitter-sequel`
- WASM: [`../tree-sitter/sql.wasm`](../tree-sitter/sql.wasm)
- License: [sql.LICENSE.txt](sql.LICENSE.txt)

| Local file                         | Upstream source                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [sql.scm](sql.scm)                 | [queries/highlights.scm](https://github.com/DerekStride/tree-sitter-sql/blob/7b51ecda191d36b92f5a90a8d1bc3faef1c7b8b8/queries/highlights.scm) |
| [sql.indents.scm](sql.indents.scm) | [queries/indents.scm](https://github.com/DerekStride/tree-sitter-sql/blob/7b51ecda191d36b92f5a90a8d1bc3faef1c7b8b8/queries/indents.scm)       |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
