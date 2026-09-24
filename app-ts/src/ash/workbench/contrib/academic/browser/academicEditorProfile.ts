import { inlineNodeViews as citationInlineNodeViews, nodeViews as citationNodeViews } from "../../../../editor/contrib/citation/browser/nodeViews.js";
import { citationToolbarActions } from "../../../../editor/contrib/citation/browser/toolbarAction.js";
import { createReferenceIndexPlugin } from "../../../../editor/contrib/citation/common/references.js";
import { nodeViews as profileNodeViews } from "../../../../editor/contrib/academic/browser/nodeViews.js";
import { createAcademicDocumentSchema, createEmptyAcademicDocument } from "../../../../editor/contrib/academic/common/schema.js";
import { ACADEMIC_DOCUMENT_CONTENT_TYPE } from "../../../services/documentEditor/common/documentTypes.js";
import type { EditorProfile } from "../../documentEditor/browser/editorProfile.js";
import { DOCUMENT_EDITOR_ID } from "../../documentEditor/browser/documentEditorInput.js";

/** Academic profile; shared document editing semantics remain in editor browser/common. */
export const academicProfile: EditorProfile = Object.freeze({
	id: "academic",
	editorId: DOCUMENT_EDITOR_ID,
	editorName: "Stanza Academic",
	collaborationSchemaId: "stanza-academic-v1",
	input: Object.freeze({
		contentTypes: [ACADEMIC_DOCUMENT_CONTENT_TYPE],
		extensions: [".ash-academic", ".ash-paper"],
	}),
	createSchema: createAcademicDocumentSchema,
	createEmptyDocument: createEmptyAcademicDocument,
	outlineNavigator: true,
	inlineNodeViews: citationInlineNodeViews,
	toolbarActions: citationToolbarActions,
	nodeViews: { ...profileNodeViews, ...citationNodeViews },
	createPlugins: () => [createReferenceIndexPlugin()],
});
