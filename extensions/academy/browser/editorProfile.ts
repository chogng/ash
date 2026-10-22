import { runLibraryCitationOperation } from './contrib/citation/common/libraryCitationApi.js';
import { createEditorProfileConfiguration } from './generalProfile.js';
import { documentContributions } from './documentContributions.js';
import { inlineNodeViews as citationInlineNodeViews, nodeViews as citationNodeViews } from "./contrib/citation/browser/nodeViews.js";
import { citationToolbarActions } from "./contrib/citation/browser/toolbarAction.js";
import { createReferenceIndexPlugin } from "./contrib/citation/common/references.js";
import { nodeViews as profileNodeViews } from "./contrib/academic/browser/nodeViews.js";
import { createAcademicDocumentSchema, createEmptyAcademicDocument } from "./contrib/academic/common/schema.js";
import { ACADEMIC_DOCUMENT_CONTENT_TYPE } from "./documentTypes.js";
import type { EditorProfile } from "ash:editor/workbench/services/documentEditor/browser/documentEditorProfile.js";

/** Academic profile; shared document editing semantics remain in editor browser/common. */
export const academicProfile: EditorProfile = Object.freeze({
	id: 'academic', contentType: ACADEMIC_DOCUMENT_CONTENT_TYPE, collaborationSchemaId: 'stanza-academic-v1',
	create: () => {
		const schema = createAcademicDocumentSchema();
		return createEditorProfileConfiguration(schema, {
			outlineNavigator: true, contributions: documentContributions,
			extensionApis: { 'academy.citations.v1': runLibraryCitationOperation },
			inlineNodeViews: citationInlineNodeViews, toolbarActions: citationToolbarActions,
			nodeViews: { ...profileNodeViews, ...citationNodeViews },
		}, [createReferenceIndexPlugin()], () => createEmptyAcademicDocument(schema));
	},
});
