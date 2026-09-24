import { type EditorInput } from "../../../browser/parts/editor/editorInput.js";
import { EditorPaneMatch } from "../../../browser/parts/editor/editorPane.js";

export const DOCUMENT_EDITOR_ID = "stanza.editor.document";

export interface EditorInputMatcher {
	readonly contentTypes?: readonly string[];
	readonly extensions?: readonly string[];
}

/** Matches structured document resources without loading their browser view. */
export function matchDocumentEditor(input: EditorInput, matcher: EditorInputMatcher): EditorPaneMatch {
	if (matcher.contentTypes?.includes(input.contentType ?? "")) return EditorPaneMatch.Default;
	const path = input.resource.path.toLowerCase();
	if (matcher.extensions?.some(extension => path.endsWith(extension.toLowerCase()))) return EditorPaneMatch.Default;
	return EditorPaneMatch.None;
}
