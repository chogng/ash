# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## ini

- Upstream: [justinmk/tree-sitter-ini](https://github.com/justinmk/tree-sitter-ini)
- Revision: `d1f6ae18e86de3c21bb6ab634ff9ab549ceb1249`
- Grammar version: `1.4.0`
- Rust dependency: `tree-sitter-ini`
- WASM: [`../tree-sitter/ini.wasm`](../tree-sitter/ini.wasm)
- License: [ini.LICENSE.txt](ini.LICENSE.txt)

| Local file                     | Upstream source                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [ini.folds.scm](ini.folds.scm) | [queries/folds.scm](https://github.com/justinmk/tree-sitter-ini/blob/d1f6ae18e86de3c21bb6ab634ff9ab549ceb1249/queries/folds.scm)           |
| [ini.scm](ini.scm)             | [queries/highlights.scm](https://github.com/justinmk/tree-sitter-ini/blob/d1f6ae18e86de3c21bb6ab634ff9ab549ceb1249/queries/highlights.scm) |

## properties

- Upstream: [tree-sitter-grammars/tree-sitter-properties](https://github.com/tree-sitter-grammars/tree-sitter-properties)
- Revision: `579b62f5ad8d96c2bb331f07d1408c92767531d9`
- Grammar version: `0.3.0`
- Rust dependency: `tree-sitter-properties`
- WASM: [`../tree-sitter/properties.wasm`](../tree-sitter/properties.wasm)
- License: [properties.LICENSE.txt](properties.LICENSE.txt)

| Local file                                 | Upstream source                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [properties.scm](properties.scm)           | [queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-properties/blob/579b62f5ad8d96c2bb331f07d1408c92767531d9/queries/highlights.scm) |
| [properties.tags.scm](properties.tags.scm) | [queries/tags.scm](https://github.com/tree-sitter-grammars/tree-sitter-properties/blob/579b62f5ad8d96c2bb331f07d1408c92767531d9/queries/tags.scm)             |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
