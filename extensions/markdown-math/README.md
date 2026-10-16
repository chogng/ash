# Markdown Math

This independently enabled Rust extension replaces the executable part of VS Code's
Markdown Math extension. It uses crates.io `katex-rs = 0.3.0` and registers the public
`math.render.v2` channel through the Rust SDK. `crates/utils/markdown-math` contains
only the shared request and response contract; neither the host nor Markdown links
the renderer.

Chat and Markdown Language Features recognize `$...$`, `$$...$$`, `\(...\)`,
`\[...\]` and complete `math` fences,
then sends one ordered batch per document render. The provider owns formula parsing,
macro expansion and HTML + MathML output. Each result explicitly reports rendered
HTML or a source fallback with an invalid-formula or output-limit diagnostic. Macro settings and document definitions
are discarded after each batch. No document buffers or editor history are retained.
The host activates this process on the first declared capability request and binds
the grant to this provider's exact deployment. Cancellation, deadlines, revocation
and crash recovery use the existing extension supervisor.

`markdown.math.enabled` and resource-scoped `markdown.math.macros` retain the VS Code
setting names. Disabling this extension leaves formula source visible in Markdown;
there is no second JavaScript renderer. Static CSS and embedded fonts come from
the package's KaTeX asset dependency through `src/styles.css`, shared by chat and
Markdown's sandboxed views.
Formula conversion does not execute that dependency's JavaScript. All formulas use
`trust: false`, bounded macro expansion, input budgets and a 512 KiB serialized
response budget. Output limits retain successful sibling formulas; even formulas
whose HTML does not fit still contribute macros to later formulas in the batch.
Consumers own escaped source fallback and localized diagnostic presentation.

Chat coalesces new batches for 32 ms and shares in-flight work when streaming
updates contain the same ordered formulas and configured macros. Prose-only updates
reuse completed batches. Each chat renderer retains at most eight completed entries
and 2 MiB of request keys plus serialized results; active requests belong to their
consumers. Losing the final consumer cancels pending work after the current event
turn, allowing a replacement render to take over. Settings, provider identity and
connection changes invalidate reuse. Individual formulas are never cached apart
from their batch's macro scope.

`test/fixtures/markdownMath.json` is the syntax conformance corpus for chat, rich
Markdown and preview. It includes escapes, currency, incomplete input, code adjacency,
CRLF/Unicode, malformed TeX, macros, matrices and stretchy SVG. The browser comparison
uses real Rust output to check MathML semantics, fonts, geometry and inherited colors
in English and Chinese. Keep these checks when changing the pinned Rust engine or
KaTeX presentation assets; matching package names alone does not establish compatibility.

Connected Desktop and Web clients use the same provider. An offline browser WASM
entry, Notebook renderer integration and LaTeX source highlighting are outside this
implementation. The Rust crate's optional WASM support is not an installed Web runtime.

Validate with `just verify ash-markdown-math`, `just verify ash-markdown-language-features`,
the extension host runtime tests, the Markdown custom-editor unit suite and
`pnpm test:browser:integration markdownEditor.integration.spec.ts --project=chromium`.
Product packages include `bin/ash-markdown-math{.exe}` and its extension metadata.
