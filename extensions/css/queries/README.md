# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## css

- Upstream: [tree-sitter/tree-sitter-css](https://github.com/tree-sitter/tree-sitter-css)
- Revision: `dda5cfc5722c429eaba1c910ca32c2c0c5bb1a3f`
- Grammar version: `0.25.0`
- Rust dependency: `tree-sitter-css`
- WASM: [`../tree-sitter/css.wasm`](../tree-sitter/css.wasm)
- License: [css.LICENSE.txt](css.LICENSE.txt)

| Local file         | Upstream source                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [css.scm](css.scm) | [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-css/blob/dda5cfc5722c429eaba1c910ca32c2c0c5bb1a3f/queries/highlights.scm) |

## scss

- Upstream: [tree-sitter-grammars/tree-sitter-scss](https://github.com/tree-sitter-grammars/tree-sitter-scss)
- Revision: `eb69c8f55ecc17235f43358c65ec644578554f92`
- Grammar version: `1.0.0`
- Rust dependency: `tree-sitter-scss`
- WASM: [`../tree-sitter/scss.wasm`](../tree-sitter/scss.wasm)
- License: [scss.LICENSE.txt](scss.LICENSE.txt)

| Local file           | Upstream source                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [scss.scm](scss.scm) | [queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-scss/blob/eb69c8f55ecc17235f43358c65ec644578554f92/queries/highlights.scm) |

## less

- Upstream: [jimliang/tree-sitter-less](https://github.com/jimliang/tree-sitter-less)
- Revision: `b95f7e9780be5c9c191bb478054106253f04acb9`
- Grammar version: `1.0.0`
- Rust dependency: `tree-sitter-less`
- WASM: [`../tree-sitter/less.wasm`](../tree-sitter/less.wasm)
- License: [less.LICENSE.txt](less.LICENSE.txt)

| Local file           | Upstream source                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [less.scm](less.scm) | [queries/highlights.scm](https://github.com/jimliang/tree-sitter-less/blob/b95f7e9780be5c9c191bb478054106253f04acb9/queries/highlights.scm) |

For Less and SCSS, concatenate `css.scm` first, followed by `less.scm` or `scss.scm`.
SCSS now uses the modern `tree-sitter-scss` 1.0.0 query matching its Rust/WASM grammar.

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
