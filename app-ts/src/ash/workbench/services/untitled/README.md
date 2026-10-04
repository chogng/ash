# Untitled editor service

This Workbench service owns the identity and bootstrap snapshot of unsaved text
editors. `UntitledTextEditorService` creates `untitled:/Untitled-N`
resources, reuses a supplied untitled resource during backup restoration, and
reserves its number for the next new editor. It releases an identity when its
last working copy closes and clears remaining identities on workspace switch.
`UntitledTextEditorInput` exposes the model's name, initial value, language and
name changes to the editor. Opening or restoring a draft passes this input to
the Editor Part; the service retains ownership of the draft model.

The service does not own text transactions, undo history, dirty comparison, or
editor presentation. The selected editor's model service remains responsible
for those semantics after it acquires the `EditorInput`. This keeps the
Workbench resource lifecycle separate from any concrete editor implementation.
An editor provider that supports Save As implements the generic
`IEditorPane.saveAs(resource)` capability; Workbench does not inspect or
serialize the provider's document.

## Current status

`Ctrl/Cmd+N` invokes `workbench.action.files.newUntitledFile` and opens a new
text editor. Explicit language IDs and bootstrap text are preserved. A new
untitled editor is clean when empty and dirty when it starts with text or gains
text; discarding it clears the text. Dirty close uses the Workbench save
confirmation. Save As writes the active model and replaces the untitled input
with the saved file input in every editor group and window. A discarded
untitled template is not offered by Reopen Closed Editor.

The working-copy backup tracker stores dirty text in IndexedDB. On startup,
Workbench recreates the original untitled resource and restores its content
before opening the next new editor.
