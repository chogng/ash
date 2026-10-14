# Academic

Optional, bundled declarative extension for structured papers. Its `customEditors`
contribution selects the existing Stanza document editor for `.ash-academic`,
`.ash-paper` and the Academic content type. The package can be disabled through
normal extension enablement; file routing and new editor registrations are then
removed. Already open documents retain their working copy until their tab closes.

The trusted renderer composes the Academic schema, citation views and reference
index with the shared editor. TextModel, undo, save and collaboration remain owned
by the Workbench. This package runs no extension scripts and exposes no DOM or
internal model API to third-party extensions. It follows the same declarative
product-renderer contract as `media-preview`, rather than introducing a new author
SDK. Pagination and PDF export are not provided.
