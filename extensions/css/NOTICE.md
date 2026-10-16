# Resource provenance

Language declarations, editing configuration and any snippets are derived from
[Microsoft VS Code](https://github.com/microsoft/vscode/tree/main/extensions/css)
and retain its [MIT license](../../third_party/vscode/LICENSE.txt).

This package uses Tree-sitter for built-in syntax analysis. Query sources, pinned
grammar revisions, local changes and individual licenses are recorded in
[`queries/README.md`](queries/README.md). Web parser assets are built from the
matching Cargo sources; their hashes and query composition are recorded in
`tree-sitter/grammars.json` where this package supplies its own WASM assets.
