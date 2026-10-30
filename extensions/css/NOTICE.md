# Resource provenance

Language declarations, editing configuration and any snippets are derived from
[Microsoft VS Code](https://github.com/microsoft/vscode/tree/main/extensions/css)
and retain its [MIT license](../../third_party/vscode/LICENSE.txt).

This package uses Tree-sitter for built-in syntax analysis. Query sources, pinned
grammar revisions, local changes and individual licenses are recorded in
[`queries/README.md`](queries/README.md). Web parser assets are built from the
matching Cargo sources; their hashes and query composition are recorded in
`tree-sitter/grammars.json` where this package supplies its own WASM assets.

## CSS logo

`media/icon.svg` is the unmodified purple CSS logo published by the CSS-Next
Community Group, based on the design by Javi Aguilar. It is dedicated to the
public domain under CC0 1.0 Universal. The complete dedication is included in
[`third-party/css-logo.CC0-1.0.txt`](third-party/css-logo.CC0-1.0.txt).

- Source: https://github.com/CSS-Next/logo.css/blob/main/css.svg
- Usage guidelines: https://github.com/CSS-Next/logo.css#logo-usage-guidelines
- Retrieved 2026-10-29; SHA-256: `28dceb38651b6d3d43119bae6f56dc6dd76415cfedd4a718afcd61fc7bec8ba3`.
