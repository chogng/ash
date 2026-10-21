# Academy / Academic

`ash.academic` is an independently installed Rust editor extension. Its
`ash-academy` executable registers the versioned `editor.client.v1` capability
through the public Rust SDK and existing Host RPC. Shared Workbench integration
projects the admitted package's live registration into the editor registry before
tab restoration; Sessions consumes it.

The extension owns general documents (`.ash-doc`), Academic papers and channel
notes. Its `common/` owns schemas, structural transactions, commands, history,
line projections, collaboration algorithms and codecs. `browser/` owns the rich
text view, paragraph/formatting contributions, node views, conversions and profiles.
The independently built factory and stylesheet are loaded from the exact installed
package. The loader verifies source identity, JS/CSS digests, host API version and
current backend admission before evaluating the factory. It supplies only the
versioned editor host mechanisms; no service container or backend connection is
passed to the module. Styles are scoped by client identity and retained while a
view exists, including a frozen view after package retirement.

Only a product-selected publisher from a pinned, verified source can currently
supply a native editor client. Installation still requires explicit exact-package
execution consent. Package IDs, `publisher`, `source: official` and client metadata
alone do not grant this authority. The code runs as admitted product code in the
Renderer; this is not a sandbox for arbitrary third-party scripts.

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
Complete product/platform acceptance and advanced Word layout remain separate roadmap
work. The supported DOCX and page-image PDF formats are described below and in the
[roadmap](../../docs/design/editor-roadmap.md).

Validate with `just verify ash-academy`, the MainThreadClientEditors / Academic
profile / DocumentEditorPane unit suites, and
`pnpm test:browser:integration academic.integration.spec.ts --project=chromium`.
Ash product packages omit Academy's executable, manifest and client implementation.
Build the runtime with the repository Rust wrappers, then stage a submission:

```sh
pnpm package:editor extensions/academic .build/academy-submission darwin-arm64=.build/cargo/ci-test/ash-academy
```

The command accepts additional `<target-platform>=<executable>` arguments. Its
output contains `catalog.json` and `package/`, ready for the registry's `editors`
family; signing and online publication belong to the registry release workflow.
A new output directory is required. Sources and build files are not payload assets.
Source maintenance remains in this repository until a separate move is chosen.
Academy's native description uses the public SDK `editor_client` types; browser
sources import only the declared `ash:editor/*` host API and package-owned modules.
The [independent development guide](../../sdk/docs/development.md) exports a complete
SDK and a separate Academy project, then builds, typechecks, loads/reloads and stages
that project without referring back to Ash source. Development code requires explicit
local-code authorization; normal package trust and execution consent still apply.
See [distribution boundaries](../../docs/design/editor-roadmap.md#67-贡献装配与市场扩展).

M6 writing and styles are owned by this package. Paragraphs and headings can reference
named document styles, retain local paragraph and character overrides, update a style
from the current paragraph, reset paragraph overrides, or delete a definition while
keeping its effective appearance. Style definitions live in the root's scalar
`paragraphStyles` JSON attribute; paragraphs retain a stable `styleId`. The existing
v2 document envelope and transaction steps remain unchanged. Older files without
these attributes retain their defaults. The schema rejects malformed definitions,
unknown references and invalid measurements before a model version is committed.
The first version supports up to 100 flat styles, with names up to 80 characters;
style inheritance chains and character-style definitions are outside this writing slice.

Paragraph fonts, spacing, logical start/end indents and first-line/hanging indents
project onto the existing input surfaces. Ordered lists use native markers with an
editable start and decimal, alphabetic or Roman format; existing nested-list input
continues through the same model. Clipboard fragments materialize named paragraph
formatting so pasting into another document does not require a second style registry.
Markdown export reports unsupported style/numbering semantics instead of silently
losing them; plain-text export remains explicitly plain.

Find and replace searches literal text across character marks within a block, including
list items, table cells and code in the parent document. Images, citations, hard breaks
and block boundaries separate search runs. Match case, Unicode whole-word matching,
wraparound navigation and visible matches work in read-only documents. Replace and
Replace all preserve unrelated marks and structure; each action is one undo step.
Search intent and highlights belong to the view and are never persisted. Ctrl+F or
Command+F opens search, Enter/Shift+Enter navigate, and Escape restores editor focus.

Collaboration replays fully validated atomic transactions and merges independent
paragraph attributes and style definitions by stable identity. No style state or
replacement history is copied into the Rust process or the shared host.

Academic citations resolve against bibliography keys. An empty citation label uses
the current reference ordinal; explicit labels remain unchanged. Reference insertion
rejects duplicate keys. Edit reference changes its key, text and every matching
citation in one undo step, while preserving reference and citation identities.
Delete reference removes an empty bibliography container and leaves its citations
visibly unresolved; undo restores resolution. Dialogs and citation labels are
localized, and citations support Tab focus and Enter/Space selection. Legacy files
with duplicate keys remain readable; ambiguous edits are rejected.
[Reference Manager](../reference-manager/README.md) owns the independent RIS library
and submits insertion/update requests through `academy.citations.v1`. Academy links
bibliography entries by library and entry IDs, validates a version-bound request,
and commits one transaction and history unit. Key changes update matching citations;
missing library entries remain in the document. Stale handles, read-only/composing
inputs, cancellation and retired providers reject edits. The shared pane exposes
only an opaque lifetime-bound call; no model or service container crosses it.
Literature search and PDF reading remain separate optional capabilities. This trusted
installed-client contract does not expose a general Host RPC document editor.

The package also owns the M6 editable body pagination slice. Paper controls select
continuous layout, A4 or Letter and persist page size and uniform margins through
the existing model transaction, codec and history. Pages form a vertical stack.
The package measures browser lines and inserts empty, non-editable page gaps into
the original DOM. Text IDs, inline marks and event owners remain intact; UTF-16
positions resolve across the split DOM Text nodes for native selection and input.
Metric changes preserve selection and wait for composition to finish. Zoom is
view-local and never changes wrapping or document versions. Advanced page structures
and viewport virtualization remain outside this slice; see the [root TODO](../../TODO.md#stanza-编辑器--todo) for
platform acceptance work.

Sections, review and file conversion remain package-owned. Root `documentSection`
containers override page intent without changing descendant identities. Comments use
mapped document positions; block revision baselines are immutable evidence in the
same v2 document, not another editable model. Structural changes promote dependent
baselines to one document revision; rejection restores that entire review unit.

The optional host artifact port carries format descriptors, bytes, cancellation and
the imported document type. It never interprets OOXML or PDF. DOCX standard parts
include supported text, styles, lists, tables, embedded images, sections, running text,
comments and paragraph insert/delete revisions. Native roundtrips also preserve a
v2 snapshot only while every standard-part digest matches. Modified Word content
uses the OOXML parser instead. Unsupported features fail before creating a draft;
imports preserve the source and resolve the admitted general or Academic profile.

PDF output is a frozen 192 dpi page-image document, with mixed page dimensions and
running text. Text is not searchable. It shares the page view, waits for resources,
and cleans up on completion, failure or cancellation. Limits are 256 pages and
64 MiB; DOCX also bounds expanded ZIP data to 64 MiB and 2,000 parts. See the
[roadmap](../../docs/design/editor-roadmap.md#64-打印与-pdf) for supported semantics
and the [root TODO](../../TODO.md#stanza-编辑器--todo) for remaining
target-application/platform acceptance work.
