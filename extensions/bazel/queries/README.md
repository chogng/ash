# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## starlark

- Upstream: [tree-sitter-grammars/tree-sitter-starlark](https://github.com/tree-sitter-grammars/tree-sitter-starlark)
- Revision: `a453dbf3ba433db0e5ec621a38a7e59d72e4dc69`
- Grammar version: `1.3.0`
- Rust dependency: `tree-sitter-starlark`
- WASM: [`../tree-sitter/starlark.wasm`](../tree-sitter/starlark.wasm)
- License: [starlark.LICENSE.txt](starlark.LICENSE.txt)

| Local file                                         | Upstream source                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [starlark.folds.scm](starlark.folds.scm)           | [queries/folds.scm](https://github.com/tree-sitter-grammars/tree-sitter-starlark/blob/a453dbf3ba433db0e5ec621a38a7e59d72e4dc69/queries/folds.scm)           |
| [starlark.scm](starlark.scm)                       | [queries/highlights.scm](https://github.com/tree-sitter-grammars/tree-sitter-starlark/blob/a453dbf3ba433db0e5ec621a38a7e59d72e4dc69/queries/highlights.scm) |
| [starlark.indents.scm](starlark.indents.scm)       | [queries/indents.scm](https://github.com/tree-sitter-grammars/tree-sitter-starlark/blob/a453dbf3ba433db0e5ec621a38a7e59d72e4dc69/queries/indents.scm)       |
| [starlark.injections.scm](starlark.injections.scm) | [queries/injections.scm](https://github.com/tree-sitter-grammars/tree-sitter-starlark/blob/a453dbf3ba433db0e5ec621a38a7e59d72e4dc69/queries/injections.scm) |
| [starlark.locals.scm](starlark.locals.scm)         | [queries/locals.scm](https://github.com/tree-sitter-grammars/tree-sitter-starlark/blob/a453dbf3ba433db0e5ec621a38a7e59d72e4dc69/queries/locals.scm)         |

## bazelrc

- Upstream: [zaucy/tree-sitter-bazelrc](https://github.com/zaucy/tree-sitter-bazelrc)
- Revision: `3cea80b67f53178518e2c5f5011b51a4f8f6c0a5`
- Grammar version: `1.0.0`
- Rust dependency: `tree-sitter-bazelrc`
- WASM: [`../tree-sitter/bazelrc.wasm`](../tree-sitter/bazelrc.wasm)
- License: [bazelrc.LICENSE.txt](bazelrc.LICENSE.txt)

| Local file                 | Upstream source                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [bazelrc.scm](bazelrc.scm) | [queries/highlights.scm](https://github.com/zaucy/tree-sitter-bazelrc/blob/3cea80b67f53178518e2c5f5011b51a4f8f6c0a5/queries/highlights.scm) |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
