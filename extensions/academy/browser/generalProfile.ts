import { importDocxDocument } from './contrib/documentOutput/docx.js';
import { localize } from 'ash:editor/nls.js';
import { bindDocumentCodec } from '../common/model/documentCodec.js';
import { RichTextEditorWidget, type RichTextEditorOptions } from './widget/richTextEditor/richTextEditorWidget.js';
import { importDocumentText, exportDocumentText, materializeDocumentImages } from './documentImportExport.js';
import { getDocumentAccessibilityHelp } from './documentAccessibility.js';
import { documentContributions } from './documentContributions.js';
import type {
	EditorProfile,
	DocumentEditorConfiguration,
} from 'ash:editor/workbench/services/documentEditor/browser/documentEditorProfile.js';
import { IDialogService } from 'ash:editor/platform/dialogs/common/dialogs.js';
import { IOpenerService } from 'ash:editor/platform/opener/common/opener.js';
import { createDefaultDocumentSchema, type DocumentSchema } from '../common/model/documentSchema.js';
import type { DocumentPlugin } from '../common/model/documentPlugin.js';
import type { DocumentNode } from '../common/model/document.js';

/** A view constructor captures optional package UI, while the host owns service injection and disposal. */
export function createEditorProfileConfiguration(
	schema: DocumentSchema,
	options: RichTextEditorOptions,
	plugins?: readonly DocumentPlugin<unknown>[],
	createEmptyDocument?: () => DocumentNode,
): DocumentEditorConfiguration {
	class ProfileWidget extends RichTextEditorWidget {
		constructor(@IDialogService dialogs: IDialogService, @IOpenerService opener: IOpenerService) {
			super(options, dialogs, opener);
		}
	}
	return {
		accessibilityHelp: () => getDocumentAccessibilityHelp(schema.documentType),
		artifactFormats: [
			{
				id: 'docx',
				extension: 'docx',
				mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				canImport: true,
				label: localize('document.output.docx', 'Word document (DOCX)'),
			},
			{
				id: 'pdf',
				extension: 'pdf',
				mimeType: 'application/pdf',
				canImport: false,
				label: localize('document.output.pdf', 'PDF (page images)'),
			},
		],
		importBinary: (bytes, format, ownerDocument, signal) => {
			if (format !== 'docx') throw new TypeError('Unsupported document input');
			return importDocxDocument(bytes, ownerDocument, signal);
		},
		codec: bindDocumentCodec(schema, plugins),
		widget: ProfileWidget,
		createEmptyDocument,
		importText: async (text, format, ownerDocument, source, readResource) => {
			const document = await materializeDocumentImages(
				importDocumentText(text, format, schema, ownerDocument, source),
				readResource,
			);
			schema.validate(document);
			return document;
		},
		exportText: (document, format) => exportDocumentText(document, schema, format),
	};
}

/** Free-form writing and channel notes share Academy semantics, not paper constraints. */
export const generalProfile: EditorProfile = Object.freeze({
	id: 'general',
	contentType: 'application/vnd.ash.document+json',
	create: () => {
		const schema = createDefaultDocumentSchema();
		return createEditorProfileConfiguration(
			schema,
			{ outlineNavigator: true, contributions: documentContributions },
			undefined,
			() => schema.createDocument([schema.createNode('paragraph')]),
		);
	},
});

export const channelNotesProfile: EditorProfile = Object.freeze({
	id: 'ash.collaboration.notes',
	contentType: 'application/vnd.ash.channel-notes+json',
	create: () =>
		createEditorProfileConfiguration(createDefaultDocumentSchema(), { contributions: documentContributions }),
});
