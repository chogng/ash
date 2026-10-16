# Tree-sitter resources

Rust and the browser use the same versioned parsers and query files. WASM assets are built with Tree-sitter CLI 0.26.3 and wasi-sdk 29.

## powershell

- Upstream: [airbus-cert/tree-sitter-powershell](https://github.com/airbus-cert/tree-sitter-powershell)
- Revision: `d398441825243b00e317e87e1829b9d6a3e54ce0`
- Published source: `tree-sitter-powershell@0.26.4`
- Source archive SHA-256: `3faf304d44b9ddd4a7d97804bb8de7daf564336dd5a526dc6de5b39238243022`
- Highlight query: [queries/highlights.scm](https://github.com/airbus-cert/tree-sitter-powershell/blob/d398441825243b00e317e87e1829b9d6a3e54ce0/queries/highlights.scm)
- Local highlight query: [powershell.scm](powershell.scm)
- WASM: [powershell.wasm](../tree-sitter/powershell.wasm)
- License: [powershell.LICENSE.txt](powershell.LICENSE.txt)

Ash-authored tags and folds select declarations and multiline blocks from these grammars. No language server is bundled by these packages.
