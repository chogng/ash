# Tree-sitter resources

The Rust syntax engine and browser Worker use these queries with the matching grammar versions.
Highlight capture names retain the upstream vocabulary; the editor maps them to theme scopes.
The Web host loads the packaged WASM assets. Rust links the grammar dependencies listed below.

## json

- Upstream: [tree-sitter/tree-sitter-json](https://github.com/tree-sitter/tree-sitter-json)
- Revision: `ee35a6ebefcef0c5c416c0d1ccec7370cfca5a24`
- Grammar version: `0.24.8`
- Rust dependency: `tree-sitter-json`
- WASM: [`../tree-sitter/json.wasm`](../tree-sitter/json.wasm)
- License: [json.LICENSE.txt](json.LICENSE.txt)

| Local file           | Upstream source                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [json.scm](json.scm) | [queries/highlights.scm](https://github.com/tree-sitter/tree-sitter-json/blob/ee35a6ebefcef0c5c416c0d1ccec7370cfca5a24/queries/highlights.scm) |

Ash-authored `*.folds.scm` and additional `*.tags.scm` queries provide structural folding
and outline entries for these grammars; they are covered by the repository license.

JSON, JSON with Comments, JSON Lines, and Code Snippets share the same parser and query resources.
The grammar accepts multiple JSON values and comments. JSONL keeps one record per line; snippets
retain JSON-with-comments editing and snippet bodies. Each mode owns its file associations.
