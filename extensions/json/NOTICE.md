# Extension grammar provenance

`JSON.tmLanguage.json` and `JSONC.tmLanguage.json` are copied from the sibling
VS Code source tree at `extensions/json/syntaxes`.

- Upstream: `microsoft/vscode`
- Grammar revision recorded by the files:
  `microsoft/vscode-JSON.tmLanguage@9bd83f1c252b375e957203f21793316203f61f70`
- License: MIT, following the upstream VS Code repository

The files are intentionally shipped as resources of the declarative
`ash.json` extension package. They are not base contracts and
must not be imported by `workbench/services/textMate/common`.
