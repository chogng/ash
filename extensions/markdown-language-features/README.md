# Ash Markdown editing

The built-in extension registers preview and rich editors with the existing custom
text editor API. It calls the independent `ash.markdown-parser` Rust extension
through the existing command/extension host protocol. Desktop and connected Web
use the same capability. Without the backend/provider the editor shows a localized
error and retains source editing; formatted rich content requires the provider.

The parser returns render nodes and UTF-16 source ranges. Inactive blocks show
formatted Markdown; click a block or press Enter/F2 to edit its original source
using Ash's existing multiline InputBox. Escape returns to formatted content.
“Edit document source” supports selections across blocks. The host's canonical
TextModel owns versions, undo/redo and persistence. Input composition is committed
only after completion, and conflicting external changes retain the local draft.
Unedited source, reference definitions, escapes, whitespace and line endings are
preserved. Raw HTML is displayed as text. Remote images are not loaded.

Large documents use the same versioned snapshots and canonical model. The view's
HTML contains only a small bootstrap; source and parsed blocks arrive in one queued
update. Client JSON envelopes are bounded at 64 MiB with separate structure limits;
the Rust parser retains its 16 MiB UTF-8 source and 24 MiB encoded payload ceilings.
Escaped JSON and render-tree size also count, so these remain bounded limits rather
than an unlimited-file guarantee.

## Build

Install the repository Rust toolchain, then:

```sh
pnpm prepare:backend
pnpm build
```

The existing backend package includes `ash-markdown-parser`; the client contains
only the editor view and math renderer. No WASM build or GUI framework is used.

```sh
just verify ash-markdown-parser
pnpm test:browser:integration markdownEditor.integration.spec.ts --project=chromium
```
