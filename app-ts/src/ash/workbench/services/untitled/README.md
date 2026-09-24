# Untitled editor service

This Workbench service owns the identity and bootstrap snapshot of unsaved text
editors. `BrowserUntitledTextEditorService` creates exact `untitled:/Untitled-N`
resources and exposes them through `IUntitledTextEditorService`.

The service does not own text transactions, undo history, dirty comparison, or
editor presentation. The selected editor's model service remains responsible
for those semantics after it acquires the `EditorInput`. This keeps the
Workbench resource lifecycle separate from any concrete editor implementation.
An editor provider that supports Save As implements the generic
`IEditorPane.saveAs(resource)` capability; Workbench does not inspect or
serialize the provider's document.

## Current status

`Ctrl/Cmd+N` invokes
`workbench.action.files.newUntitledFile`, creates a new Workbench input, and
opens it through the default text editor provider. Explicit language IDs and
bootstrap text are preserved on the input. In Electron, `Ctrl/Cmd+S` runs
Workbench's Save As coordinator, writes the active editor content to the
selected file, and replaces the virtual input with the saved file input.

Dirty-close confirmation, cross-window restoration, and crash backup are not
part of this slice yet. They require a document/working-copy contract that can
persist a model snapshot without moving text transaction ownership into the
Workbench service.
