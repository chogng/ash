# Markdown Math

This independently enabled Rust extension replaces the executable part of VS Code's
Markdown Math extension. It uses crates.io `katex-rs = 0.3.0` and registers the public
`math.render.v1` channel through the Rust SDK. `crates/utils/markdown-math` contains
only the shared request and response contract; neither the host nor Markdown links
the renderer.

Markdown Language Features recognizes inline/display formulas and `math` fences,
then sends one ordered batch per document render. The provider owns formula parsing,
macro expansion and HTML + MathML output. Macro settings and document definitions
are discarded after each batch. No document buffers or editor history are retained.
The host activates this process on the first declared capability request and binds
the grant to this provider's exact deployment. Cancellation, deadlines, revocation
and crash recovery use the existing extension supervisor.

`markdown.math.enabled` and resource-scoped `markdown.math.macros` retain the VS Code
setting names. Disabling this extension leaves formula source visible in Markdown;
there is no second JavaScript renderer. Static CSS and embedded fonts come from
the package's KaTeX asset dependency and are bundled into Markdown's sandboxed views.
Formula conversion does not execute that dependency's JavaScript. All formulas use
`trust: false`, bounded macro expansion, input and output budgets.

Connected Desktop and Web clients use the same provider. An offline browser WASM
entry, Notebook renderer integration and LaTeX source highlighting are outside this
implementation. The Rust crate's optional WASM support is not an installed Web runtime.

Validate with `just verify ash-markdown-math`, `just verify ash-markdown-language-features`,
the extension host runtime tests, the Markdown custom-editor unit suite and
`pnpm test:browser:integration markdownEditor.integration.spec.ts --project=chromium`.
Product packages include `bin/ash-markdown-math{.exe}` and its extension metadata.
