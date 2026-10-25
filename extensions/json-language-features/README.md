# JSON Language Features

Built-in Browser extension for JSON and JSON with Comments in the IDE and Agents
windows. Both languages share completion, hover, document formatting and diagnostics
through the public `@ash/sdk`, using `vscode-json-languageservice` and `jsonc-parser`.
JSONC accepts comments and trailing commas; JSON reports them as errors. Formatting
preserves comments and rejects invalid input rather than rewriting a damaged document.

The host owns text models, edits, undo, saving and the JSON schema registry. The
extension reads detached schema contributions and invalidates its language-service
cache when their owner reports changes. Registered references resolve locally;
arbitrary remote schemas are not fetched. Diagnostics follow document versions and
are cleared when documents close or the extension retires.

Disabling this extension withdraws its editing providers and diagnostics. The `json`
declaration extension still supplies language IDs, associations, editing rules and
syntax assets. Core configuration parsing, validation and comment-preserving read/write
utilities remain independent of executable extensions.

Validation:

```sh
pnpm prepare:extensions
pnpm exec bun check -p extensions/json-language-features/tsconfig.json --all
pnpm test:unit --runGlob 'extensions/json-language-features/test/**/*.test.js'
```
