import { ACADEMIC_DOCUMENT_CONTENT_TYPE } from "../../../services/documentEditor/common/documentTypes.js";
import { type EditorInput } from "../../../browser/parts/editor/editorInput.js";
import { EditorPaneMatch } from "../../../browser/parts/editor/editorPane.js";
import { isTextResourceLanguageInput, resolveTextResourceLanguageId, type TextResourceLanguageResolver } from "../../../../platform/language/common/textResourceLanguage.js";
import { isDiffEditorInput } from "../../../common/editor/diffEditorInput.js";
import { isRemoteResource } from "../../../../platform/remote/common/remote.js";
import { CODE_EDITOR_ID } from "../../../browser/parts/editor/textResourceEditor.js";


/** Selects the canonical editor for plain-text resources. */
export function matchCodeEditor(input: EditorInput): EditorPaneMatch {
	if (isDiffEditorInput(input)) return EditorPaneMatch.None;
	if (input.contentType === ACADEMIC_DOCUMENT_CONTENT_TYPE) return EditorPaneMatch.None;
	if (input.resource.scheme === "untitled") return EditorPaneMatch.Default;
	if (input.languageId !== undefined || isTextResourceLanguageInput(input)) return EditorPaneMatch.Default;
	return input.resource.scheme === "file" || isRemoteResource(input.resource) ? EditorPaneMatch.Builtin : EditorPaneMatch.None;
}

/** Selects the dedicated text diff pane only for explicit diff inputs. */
export function matchDiffEditor(input: EditorInput): EditorPaneMatch {
	return isDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None;
}

/** Resolves the language identity shared by editor input, syntax, and completion. */
export function languageForEditorInput(input: EditorInput & { readonly firstLine?: string }, resolver?: TextResourceLanguageResolver): string {
	return input.languageId ?? resolveTextResourceLanguageId(input, resolver);
}
