# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## go

- Upstream: [tree-sitter/tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go)
- Revision: `1547678a9da59885853f5f5cc8a99cc203fa2e2c`
- Grammar version: `0.25.0`
- Rust dependency: `tree-sitter-go`
- WASM: [`../tree-sitter/go.wasm`](../tree-sitter/go.wasm)
- License: [go.LICENSE.txt](go.LICENSE.txt)

| Local file                 | Upstream source                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [go.scm](go.scm)           | [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-go/blob/1547678a9da59885853f5f5cc8a99cc203fa2e2c/queries/highlights.scm) |
| [go.tags.scm](go.tags.scm) | [queries/tags.scm](https://github.com/tree-sitter/tree-sitter-go/blob/1547678a9da59885853f5f5cc8a99cc203fa2e2c/queries/tags.scm)             |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
