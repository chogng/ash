# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## gitcommit

- Upstream: [gbprod/tree-sitter-gitcommit](https://github.com/gbprod/tree-sitter-gitcommit)
- Revision: `33fe8548abcc6e374feaac5724b5a2364bf23090`
- Grammar version: `0.5.0`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [gitcommit.LICENSE.txt](gitcommit.LICENSE.txt)

| Local file                                           | Upstream source                                                                                                                                |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [gitcommit.scm](gitcommit.scm)                       | [queries/highlights.scm](https://github.com/gbprod/tree-sitter-gitcommit/blob/33fe8548abcc6e374feaac5724b5a2364bf23090/queries/highlights.scm) |
| [gitcommit.injections.scm](gitcommit.injections.scm) | [queries/injections.scm](https://github.com/gbprod/tree-sitter-gitcommit/blob/33fe8548abcc6e374feaac5724b5a2364bf23090/queries/injections.scm) |

## git-rebase

- Upstream: [the-mikedavis/tree-sitter-git-rebase](https://github.com/the-mikedavis/tree-sitter-git-rebase)
- Revision: `32686d6b72980b36f876ae2d07719c9c3ed154e2`
- Grammar version: `0.1.0`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [git-rebase.LICENSE.txt](git-rebase.LICENSE.txt)

| Local file                       | Upstream source                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [git-rebase.scm](git-rebase.scm) | [queries/highlights.scm](https://github.com/the-mikedavis/tree-sitter-git-rebase/blob/32686d6b72980b36f876ae2d07719c9c3ed154e2/queries/highlights.scm) |

## gitignore

- Upstream: [shunsambongi/tree-sitter-gitignore](https://github.com/shunsambongi/tree-sitter-gitignore)
- Revision: `f4685bf11ac466dd278449bcfe5fd014e94aa504`
- Grammar version: `0.1.0`
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- License: [gitignore.LICENSE.txt](gitignore.LICENSE.txt)

| Local file                     | Upstream source |
| ------------------------------ | --------------- |
| [gitignore.scm](gitignore.scm) | Authored in Ash |

`gitignore.scm` is authored in Ash because its upstream grammar supplies no query.
Its language binding and Bazelrc use small local Rust bindings around pinned upstream C parsers.
Git commit WASM is compiled from the same grammar source as its Cargo dependency.

The Git commit WebAssembly build splits the generated lexer into bounded helper functions
to avoid LLVM's pathological large-function behavior; grammar tables and scanner semantics
remain unchanged. The checked-in corpus compares it against the unmodified parser on 64
upstream inputs. Its scanner links only WASI libc's `iswcntrl` object, which is absent from
the shipped Web runtime; the musl license is preserved in `../tree-sitter/musl.LICENSE.txt`.

Ash adds comment recovery for an unfinished final commit comment and a bounded Diff
injection for verbose commit buffers without a scissors marker. Rebase `exec`/`x`
operations use the Ash-authored `git-rebase.injections.scm` Shell injection.

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.
