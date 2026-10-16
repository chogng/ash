# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## markdown

- Upstream: [tree-sitter-grammars/tree-sitter-markdown](https://github.com/tree-sitter-grammars/tree-sitter-markdown)
- Revision: `f969cd3ae3f9fbd4e43205431d0ae286014c05b5`
- Grammar version: `0.5.3`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [markdown.LICENSE.txt](markdown.LICENSE.txt)

| Local file                                         | Upstream source                                                                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [markdown.scm](markdown.scm)                       | [tree-sitter-markdown/queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-markdown/blob/f969cd3ae3f9fbd4e43205431d0ae286014c05b5/tree-sitter-markdown/queries/highlights.scm) |
| [markdown.injections.scm](markdown.injections.scm) | [tree-sitter-markdown/queries/injections.scm](https://github.com/tree-sitter-grammars/tree-sitter-markdown/blob/f969cd3ae3f9fbd4e43205431d0ae286014c05b5/tree-sitter-markdown/queries/injections.scm) |

## markdown-inline

- Upstream: [tree-sitter-grammars/tree-sitter-markdown](https://github.com/tree-sitter-grammars/tree-sitter-markdown)
- Revision: `f969cd3ae3f9fbd4e43205431d0ae286014c05b5`
- Grammar version: `0.5.3`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [markdown-inline.LICENSE.txt](markdown-inline.LICENSE.txt)

| Local file                                                       | Upstream source                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [markdown-inline.scm](markdown-inline.scm)                       | [tree-sitter-markdown-inline/queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-markdown/blob/f969cd3ae3f9fbd4e43205431d0ae286014c05b5/tree-sitter-markdown-inline/queries/highlights.scm) |
| [markdown-inline.injections.scm](markdown-inline.injections.scm) | [tree-sitter-markdown-inline/queries/injections.scm](https://github.com/tree-sitter-grammars/tree-sitter-markdown/blob/f969cd3ae3f9fbd4e43205431d0ae286014c05b5/tree-sitter-markdown-inline/queries/injections.scm) |

`markdown.scm` retains raw-code styling for fenced content without a supported injection.

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
