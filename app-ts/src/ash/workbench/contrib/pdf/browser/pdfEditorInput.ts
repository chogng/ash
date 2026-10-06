import type { IResourceEditorInput } from '../../../common/editor.js';

import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';

export const PDF_EDITOR_ID = "ash.workbench.pdfViewer";
export const PDF_CONTENT_TYPE = "application/pdf";

/** Matches workspace PDF resources without requiring their bytes to be loaded. */
export function matchPdfEditor(input: IResourceEditorInput): EditorPaneMatch {
	if (contentType(input) === PDF_CONTENT_TYPE) return EditorPaneMatch.Default;
	return input.resource.path.toLowerCase().endsWith(".pdf")
		? EditorPaneMatch.Default
		: EditorPaneMatch.None;
}

function contentType(input: IResourceEditorInput): string | undefined {
	const value = input.contentType?.split(";", 1)[0]?.trim().toLowerCase();
	return value || undefined;
}
