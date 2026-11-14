/** Saved key for the initial formatted or source view of Markdown Docs. */
export const DOCS_DEFAULT_MODE_SETTING = 'sessions.docs.editor';
export type DocsEditorMode = 'rich' | 'markdown';

/** Legacy formats are accepted only by the one-way Docs importer. */
export const LEGACY_DOCS_CONTENT_TYPE = 'application/vnd.ash.document+json';
export const LEGACY_DOCS_FILE_EDITOR_ID = 'ash.editor.document';
export const LEGACY_DOCS_EDITOR_ID = 'sessions.editor.docs';
/** Persisted identity for Arkdown-backed Markdown Docs. */
export const DOCS_ARKDOWN_EDITOR_ID = 'sessions.editor.docs.markdown';
