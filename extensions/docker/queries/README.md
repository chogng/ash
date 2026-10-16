# Tree-sitter resources

Rust and the browser use the same versioned parsers and query files. WASM assets are prepared from the pinned Ash grammar release.

## containerfile

- Upstream: [wharflab/tree-sitter-containerfile](https://github.com/wharflab/tree-sitter-containerfile)
- Revision: `1df9124b22a72dde8683aab6f762ff4857acfeab`
- Published source: `tree-sitter-containerfile@0.9.2`
- Source archive SHA-256: `f4811d55a5a2c32bb024b441c32b7417c3ec1af1a080a25fa20d321627b65a2b`
- Highlight query: [queries/highlights.scm](https://github.com/wharflab/tree-sitter-containerfile/blob/1df9124b22a72dde8683aab6f762ff4857acfeab/queries/highlights.scm)
- Local highlight query: [containerfile.scm](containerfile.scm)
- Parser artifacts: [pinned Ash grammar release](../../../third_party/ash-grammars/README.md)
- Licenses: [containerfile.LICENSE-MIT-CamdenCheek.txt](containerfile.LICENSE-MIT-CamdenCheek.txt), [containerfile.LICENSE.txt](containerfile.LICENSE.txt)

Ash-authored tags and folds select declarations and multiline blocks from these grammars. No language server is bundled by these packages.
