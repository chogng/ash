# Tree-sitter fixtures

`languages.json` contains Ash-authored examples for default language registration and highlighting.

`gitcommit.json` preserves 64 upstream Git commit corpus inputs and the syntax trees produced by
the unmodified native 0.5.0 parser. It checks the WebAssembly build's lexer transformation against
that reference, including translated generated comments and recovery cases. Corpus origin is
recorded in the fixture; its MIT license is preserved in
[`gitcommit.LICENSE.txt`](../../../extensions/git-base/queries/gitcommit.LICENSE.txt).
