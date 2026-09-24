import type { EditorInput } from "../../../browser/parts/editor/editorInput.js";
import { EditorPaneMatch } from "../../../browser/parts/editor/editorPane.js";

export const PDF_EDITOR_ID = "ash.workbench.pdfViewer";
export const PDF_CONTENT_TYPE = "application/pdf";

/** Matches workspace PDF resources without requiring their bytes to be loaded. */
export function matchPdfEditor(input: EditorInput): EditorPaneMatch {
	if (contentType(input) === PDF_CONTENT_TYPE) return EditorPaneMatch.Default;
	return decodedResourcePath(input).toLowerCase().endsWith(".pdf")
		? EditorPaneMatch.Default
		: EditorPaneMatch.None;
}

function contentType(input: EditorInput): string | undefined {
	const value = input.contentType?.split(";", 1)[0]?.trim().toLowerCase();
	return value || undefined;
}

function decodedResourcePath(input: EditorInput): string {
	try {
		return decodeURIComponent(input.resource.path);
	} catch {
		return input.resource.path;
	}
}
