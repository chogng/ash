# Resource provenance

Language declarations, editing configuration and any snippets are derived from
[Microsoft VS Code](https://github.com/microsoft/vscode/tree/main/extensions/rust)
and retain its [MIT license](../../third_party/vscode/LICENSE.txt).

The public server configuration schemas, defaults and English descriptions are generated
by rust-analyzer release [2026-10-12](https://github.com/rust-lang/rust-analyzer/releases/tag/2026-10-12),
binary version `0.3.3081-standalone` at commit `2ad81e72b7`.
These declarative configuration contracts retain rust-analyzer's
[MIT license](settings.LICENSE-MIT.txt). Ash supplies its own Settings integration, titles,
Chinese translations and cache-priming default. No VS Code extension implementation is included.

This package uses Tree-sitter for built-in syntax analysis. Query sources, pinned
grammar revisions, local changes and individual licenses are recorded in
[`queries/README.md`](queries/README.md). Web parser assets are built from the
matching Cargo sources; their hashes and query composition are recorded in
`tree-sitter/grammars.json` where this package supplies its own WASM assets.
