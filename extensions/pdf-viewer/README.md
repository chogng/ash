# PDF Viewer

PDF Viewer (`ash.pdf-viewer`) is an optional, independently installed editor extension for the Agents Window. Its window ownership is defined in the [extension architecture](../../docs/editor-extensions.md#可选文献管理与-pdf-资源编辑器). Ash does not bundle its executable, client, PDF.js parser or worker. Academy can export PDF without installing this reader. Literature retrieval and reference-library management (including RIS import) belong to separate optional capabilities; neither is a dependency of this package.

The extension owns PDF rendering, extracted text, highlight/ink/note annotations and their undo history. It keeps the source PDF immutable and saves annotations in `<file>.pdf.ash-annotations.json` through the window's authorized file service. Existing `ash.workbench.pdfViewer` editor identities and version-1 annotation files remain supported. Saved annotations reload when the file is reopened; unsaved annotations are pane-local and must be saved before closing. This is not an embedded-PDF annotation exporter, reference manager, or OCR engine.

## Planned PDF reading, annotations and AI use

The separate [PDF content plan](docs/pdf-content.md) scopes future work to viewing, extension-owned annotations and AI access to text or page images, composed with a Skill and a Plugin bundle where supported. It does not require a general document-editing API. The plan distinguishes existing viewer behavior from unimplemented AI/tool/Skill integration; it does not change package admission or add runtime capabilities.

## Installation and lifecycle

Install the separately distributed `editor` package through Extensions, enable it and grant execution consent for that exact package. It uses the same signed catalog, verified publisher, product-runtime admission and revocable consent path as Academy. A source or package cannot grant itself first-party renderer privileges.

An admitted Rust process registers `editor.resource.v1`. Its `describe` response names the closed `dist/editor.js` factory, its native-bound source digest, and the manifest-declared PDF editor. The host verifies the installed JS and CSS bytes, package/API/version identity and current admission before executing the factory. Only generic editor, file, UI and lifecycle mechanisms cross the client boundary. PDF bytes never become a text document model.

In the Agents Window, both file opening and Chat attachment previews consume the registered resource editor. Chat passes immutable attachment bytes to a read-only pane without reading an annotation sidecar. Without the extension, Chat keeps its download/open actions and binary placeholder. There is no static PDF fallback.

Disabling, revoking, uninstalling or replacing the provider removes new-open routing and cancels document loading and cancellable writes; late sidecar reads are rejected before they can update the pane. Existing painted pages and annotation drafts stay visible, frozen; parser/worker resources are released. Re-enabling does not resume the retired pane. Reopen to use the new provider. Closing the pane releases its DOM, handlers and scoped stylesheet lease.

## Keyboard and accessibility

Tab reaches tools, each page and annotation fields. On a page, arrows position the annotation cursor; Enter places a note or starts/finishes a highlight or ink stroke, and Escape cancels a stroke. The annotation list supports arrows, Home and End. Open Accessibility Help explains the controls, and Open Accessible View reads PDF text and annotations. Agents Window Settings → General exposes `accessibility.verbosity.resourceEditor` to control the help hint. Scanned PDFs without a text layer need an independent OCR capability. Labels, help and provider descriptions support English and Simplified Chinese.

## Build and distribution

```sh
just verify ash-pdf-viewer
pnpm package:editor extensions/pdf-viewer .build/pdf-viewer-submission darwin-arm64=.build/cargo/ci-test/ash-pdf-viewer
pnpm test:browser:integration pdfExtension.integration.spec.ts --project=chromium
```

Supply an executable for each additional supported target with another `target=path` argument. The command creates a neutral `catalog.json` and `package/` submission. The signed registry owns publication; staging a submission does not publish it. PDF.js and its worker are bundled inside the digest-verified client, without CDN requests or product PDF assets. Declared npm dependencies are allowed only within their resolved package roots; imports of undeclared modules or private Ash services fail packaging. Native source identity covers the package's TS/CSS; signed JS/CSS digests also cover bundled dependency bytes.

The opt-in Desktop publisher corpus installs and authorizes this optional package through a test-owned signed HTTPS registry before opening PDFs in the Agents Window. The synthetic annotation scenario also verifies that the same installation exposes neither a PDF reader nor its setting in the IDE. Set `ASH_PDF_VIEWER_DISTRIBUTION` to a signed distribution directory and `ASH_PDF_VIEWER_TRUSTED_ROOT` to its pinned public root, then run `pnpm test:app:pdf-corpus`. Supply a native executable for the current test host; the runner does not reuse an installed user profile or substitute a built-in viewer. This network/Electron corpus remains a separate platform acceptance scenario.

The local acceptance covers a real SDK process, Chromium rendering and canvas pixels, source-byte preservation, saved sidecar reload, read-only/retired panes, localized labels, integrity rejection and stylesheet release. Signed-package installation separately exercises search, download, admission, exact consent, revocation and uninstall through the product launcher. Real Electron multi-window, remote files, physical screen readers and other OS targets remain part of the extension/document-host acceptance scope in the root TODO.
