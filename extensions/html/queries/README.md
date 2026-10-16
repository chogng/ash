# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## html

- Upstream: [tree-sitter/tree-sitter-html](https://github.com/tree-sitter/tree-sitter-html)
- Revision: `5a5ca8551a179998360b4a4ca2c0f366a35acc03`
- Grammar version: `0.23.2`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [html.LICENSE.txt](html.LICENSE.txt)

| Local file                                 | Upstream source                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [html.scm](html.scm)                       | [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-html/blob/5a5ca8551a179998360b4a4ca2c0f366a35acc03/queries/highlights.scm) |
| [html.injections.scm](html.injections.scm) | [queries/injections.scm](https://github.com/tree-sitter/tree-sitter-html/blob/5a5ca8551a179998360b4a4ca2c0f366a35acc03/queries/injections.scm) |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
