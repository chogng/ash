# Academy / Academic

`ash.academic` is a preinstalled, independently supervised Rust extension. Its
`ash-academy` executable registers the versioned `editor.client.v1` capability
through the public Rust SDK and existing Host RPC. Shared Workbench integration
projects that live registration into the editor registry before tab restoration;
Sessions consumes it.
There is no Sessions registration or built-in Academic pane factory.

The extension owns general documents (`.ash-doc`), Academic papers and channel
notes. Its `common/` owns schemas, structural transactions, commands, history,
line projections, collaboration algorithms and codecs. `browser/` owns the rich
text view, paragraph/formatting contributions, node views, conversions and profiles.
The product-compiled client module is loaded on first use.
Before importing it, the loader checks the client source digest supplied by the
Rust executable, the exact package version and current package admission. Only
product-compiled modules are supported; downloaded catalog bytes never execute
in the Renderer. The module receives no service container or backend connection.

The shared model service owns resource references, working copies, dirty state,
file persistence and collaboration connections. The package's `DocumentTextModel`
extends the one core TextModel; semantic transactions commit through the core's
generic snapshot/version boundary. There is one text buffer and one active edit
history, with no backend copy of either. The profile is fixed for the
pane lifetime. Disablement or process retirement removes new routing, cancels
pending registration and freezes existing views without closing their working
copies. Package declarations reserve structured routing while disabled, so a missing
provider cannot silently expose these resources to the default text editor. Re-enabling does not resume an old view; explicit reopening can acquire
the same working copy and history through the replacement capability.

`ash.academic`, `stanza.editor.document`, the existing Academic MIME type,
`.ash-academic`, `.ash-paper` and `stanza-academic-v1` remain compatible.
`ash.editor.document`, the general document MIME type, `ash.collaboration.notes`
and the channel-note MIME type also remain compatible. Paragraph contributions
are installed per profile/view, never through the global Code contribution registry.
Code extraction, complete product/platform acceptance and new Word features such
as pagination, DOCX or PDF remain separate roadmap work. See the [roadmap](../../docs/design/editor-roadmap.md).

Validate with `just verify ash-academy`, the MainThreadClientEditors / Academic
profile / DocumentEditorPane unit suites, and
`pnpm test:browser:integration academic.integration.spec.ts --project=chromium`.
The product package carries `bin/ash-academy{.exe}` and declaration/NLS resources;
Rust sources, client TypeScript sources and Cargo/build files are build inputs.
