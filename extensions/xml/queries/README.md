# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## xml

- Upstream: [tree-sitter-grammars/tree-sitter-xml](https://github.com/tree-sitter-grammars/tree-sitter-xml)
- Revision: `4b64dd3a03ec002258d6268d712fd93716d6ab57`
- Grammar version: `0.7.0`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [xml.LICENSE.txt](xml.LICENSE.txt)

| Local file         | Upstream source                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [xml.scm](xml.scm) | [queries/xml/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-xml/blob/4b64dd3a03ec002258d6268d712fd93716d6ab57/queries/xml/highlights.scm) |

## dtd

- Upstream: [tree-sitter-grammars/tree-sitter-xml](https://github.com/tree-sitter-grammars/tree-sitter-xml)
- Revision: `4b64dd3a03ec002258d6268d712fd93716d6ab57`
- Grammar version: `0.7.0`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [dtd.LICENSE.txt](dtd.LICENSE.txt)

| Local file         | Upstream source                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [dtd.scm](dtd.scm) | [queries/dtd/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-xml/blob/4b64dd3a03ec002258d6268d712fd93716d6ab57/queries/dtd/highlights.scm) |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
