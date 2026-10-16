# Ash Markdown language features

One preinstalled Rust extension owns Markdown preview, rich editing, link completion,
definitions, references, rename, workspace heading search and link diagnostics.
Its internal `parser` module uses `pulldown-cmark`; there is no separate parser
extension, command or process. Syntax highlighting, outline, folding and structural
selection use the editor's shared Rust Tree-sitter (and the Web Worker fallback).
Grammar/query resources remain in `markdown-basics`.
Opening a Markdown document or invoking a contributed command can activate the
extension immediately, without waiting for the rest of workbench startup.

Formula rendering belongs to the independently enabled [`markdown-math`](../markdown-math/README.md)
Rust extension. Markdown sends inline/display formulas and `math` fences in document
order through its declared `math.render.v1` capability. Macro definitions are scoped
to one render. Both views consume the returned HTML + MathML; their static bundles
include formula styles and fonts, with no JavaScript formula renderer. Missing or
disabled math retains formula source and does not prevent Markdown editing.

The public Rust SDK registers commands, custom text editors, language providers and
client document/workspace observations. Versioned snapshots are analysis input;
the existing client TextModel owns edits, dirty state, save, conflicts and undo/redo.
Dirty documents precede authorized resource reads. Workspace rename results include
expected source text and file operations for the client's single transaction.

The rich view's JavaScript and CSS are static package resources compiled by
`build/builtin`, not a JavaScript extension entry point. The host resolves resources
within the owning product package and executes them inside its existing sandboxed
Webview. HTML is inert in the rich view; remote images are not fetched automatically.
The readonly and input composition behavior stays in the client view.

Both views update their existing sandbox and retain unchanged DOM. Rich edits use
versioned UTF-16 ranges; preview heading IDs, metadata and math use the same Markdown
semantics as language features. A bounded analysis cache shares exact snapshots across
requests, including their sparse UTF-16 line index. Document observations build a bounded
link dependency index once, then update diagnostics for the changed document and its open
dependents without fetching all open buffers again. Closing a document releases its cached
analysis and dependency entry; interrupted refreshes rebuild from current client snapshots.
Leading-slash links use the containing workspace folder, including nested multi-root folders.
Compact render tuples keep prose-heavy documents within transport quotas;
an oversized provider result returns a recoverable error instead of ending the process.

Disable the functional extension to retire its process and providers; source
editing and Tree-sitter remain available. Browser hosts need an authorized backend
for this executable provider; the grammar WASM fallback does not run Rust extensions.

Validate with `just verify ash-markdown-language-features`, the custom-editor unit
suite, `pnpm test:browser:integration markdownEditor.integration.spec.ts --project=chromium`,
and the Python packaging tests. `pnpm prepare:backend` packages the executable as
`bin/ash-markdown-language-features{.exe}` with the functional extension's resources.
