import { documentCodec } from '../common/model/documentCodec.js';
import { RichTextEditorWidget } from './widget/richTextEditor/richTextEditorWidget.js';
import { importDocumentText, exportDocumentText } from './documentImportExport.js';
import { documentContributions } from './documentContributions.js';
import type { EditorProfile } from '../../../src/ash/workbench/services/documentEditor/browser/documentEditorProfile.js';
import { createDefaultDocumentSchema, type DocumentSchema } from '../common/model/documentSchema.js';

/** Free-form writing and channel notes share Academy semantics, not paper constraints. */
export const generalProfile: EditorProfile = Object.freeze({
	codec: documentCodec, widget: RichTextEditorWidget, importText: importDocumentText, exportText: exportDocumentText,
	id: 'general', contentType: 'application/vnd.ash.document+json',
	createSchema: createDefaultDocumentSchema,
	createEmptyDocument: (schema: DocumentSchema) => schema.createDocument([schema.createNode('paragraph')]),
	outlineNavigator: true,
	contributions: documentContributions,
});

export const channelNotesProfile: EditorProfile = Object.freeze({
	...generalProfile, outlineNavigator: false, createEmptyDocument: undefined, id: 'ash.collaboration.notes', contentType: 'application/vnd.ash.channel-notes+json',
});
