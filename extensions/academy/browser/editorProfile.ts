import { runLibraryCitationOperation } from './contrib/citation/common/libraryCitationApi.js';
import { createEditorProfileConfiguration } from './generalProfile.js';
import { documentContributions } from './documentContributions.js';
import { inlineNodeViews as citationInlineNodeViews, nodeViews as citationNodeViews } from './contrib/citation/browser/nodeViews.js';
import { citationToolbarActions } from './contrib/citation/browser/toolbarAction.js';
import { createReferenceIndexPlugin } from './contrib/citation/common/references.js';
import { nodeViews as profileNodeViews } from './contrib/academy/browser/nodeViews.js';
import { createAcademyDocumentSchema, createEmptyAcademyDocument } from './contrib/academy/common/schema.js';
import { ACADEMY_DOCUMENT_CONTENT_TYPE } from './documentTypes.js';
import type { EditorProfile } from 'ash:editor/workbench/services/documentEditor/browser/documentEditorProfile.js';

/** Academy profile; shared document editing semantics remain in editor browser/common. */
export const academyProfile: EditorProfile = Object.freeze({
	id: 'academy',
	editorId: 'stanza.editor.document',
	contentType: ACADEMY_DOCUMENT_CONTENT_TYPE,
	collaborationSchemaId: 'stanza-academy-v1',
	create: () => {
		const schema = createAcademyDocumentSchema();
		return createEditorProfileConfiguration(
			schema,
			{
				outlineNavigator: true,
				contributions: documentContributions,
				extensionApis: { 'academy.citations.v1': runLibraryCitationOperation },
				inlineNodeViews: citationInlineNodeViews,
				toolbarActions: citationToolbarActions,
				nodeViews: { ...profileNodeViews, ...citationNodeViews },
			},
			[createReferenceIndexPlugin()],
			() => createEmptyAcademyDocument(schema),
		);
	},
});
