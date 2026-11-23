# Ash Markdown language features

One preinstalled Rust extension owns Markdown preview, link completion,
definitions, references, rename, workspace heading search and link diagnostics.
The preview uses `pulldown-cmark`. Syntax highlighting, outline, folding and structural
selection use the editor's shared Rust Tree-sitter (and the Web Worker fallback).
Grammar/query resources remain in `markdown-basics`.
Opening a Markdown source editor or preview activates the extension on demand.
The native [Arkdown editor](../../src/ash/workbench/contrib/markdown/README.md)
loads separately for visual editing in Docs and Code.

Formula rendering belongs to the independently enabled [`markdown-math`](../markdown-math/README.md)
Rust extension. Chat, rich editing and preview share the `$...$`, `$$...$$`, `\(...\)`,
`\[...\]` and complete `math` fence syntax, tested against one compatibility corpus.
Escaped delimiters, currency, code examples and incomplete input stay literal.
Markdown sends recognized formulas in document order through its declared `math.render.v2` capability. Macro definitions are scoped
to one render. The preview includes formula styles and fonts for the returned HTML and MathML. Missing or
disabled math retains formula source and does not prevent Markdown editing.

Ash Chat invokes this extension's `markdown.mermaid.render.v1` capability for
closed Mermaid fences. Rust parses and lays out the diagram and returns a bounded
SVG. Chat displays the image and keeps the original code available. Missing
providers, unsupported syntax and limit violations leave the source visible.

The public Rust SDK registers commands, custom text editors, language providers and
client document/workspace observations. Versioned snapshots are analysis input;
the existing client TextModel owns edits, dirty state, save, conflicts and undo/redo.
Dirty documents precede authorized resource reads. Workspace rename results include
expected source text and file operations for the client's single transaction.

The host loads preview resources from the owning package into an isolated Webview.
Successive snapshots update the existing view and retain unchanged DOM.

Preview heading IDs, metadata and math use the same Markdown
semantics as language features. Settings groups separate language features, validation
and preview. `markdown.preview.fontFamily` controls body text and headings,
`markdown.preview.codeFontFamily` controls inline code and code blocks, and
`markdown.preview.blockquoteFontFamily` controls quoted text (following the body
font when empty). These fonts, `markdown.preview.fontSize` and
`markdown.preview.lineHeight` use the existing user/workspace settings and refresh
open previews when changed. Font controls distinguish system defaults from custom
families without changing the stored CSS font lists.

A bounded analysis cache shares exact snapshots across
requests, including their sparse UTF-16 line index. Document observations build a bounded
link dependency index once, then update diagnostics for the changed document and its open
dependents without fetching all open buffers again. Closing a document releases its cached
analysis and dependency entry; interrupted refreshes rebuild from current client snapshots.
Leading-slash links use the containing workspace folder, including nested multi-root folders.
Oversized preview requests return a recoverable error.

Disable the functional extension to retire its process and providers; source
editing and Tree-sitter remain available. Browser hosts need an authorized backend
for this executable provider; the grammar WASM fallback does not run Rust extensions.

Validate with `just verify ash-markdown-language-features`, the custom-editor unit
suite, `pnpm test:browser:integration markdownEditor.integration.spec.ts --project=chromium`,
and the Python packaging tests. `pnpm prepare:backend` packages the executable as
`bin/ash-markdown-language-features{.exe}` with the functional extension's resources.
