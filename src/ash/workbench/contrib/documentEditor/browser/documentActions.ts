import type { DocumentTextFormat } from '../../../services/documentEditor/common/documentCodec.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { getMediaMime } from '../../../../base/common/mime.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileTextModelService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { IUntitledTextEditorService } from '../../../services/untitled/common/untitledTextEditorService.js';
import { UntitledTextEditorInput } from '../../../services/untitled/common/untitledTextEditorInput.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import type { DocumentNode } from '../../../services/documentEditor/common/documentCodec.js';
import { localize } from '../../../../nls.js';
import { DocumentEditorPane } from './documentEditorPane.js';
import { EditorPanes } from '../../../browser/editor.js';
import { GENERAL_DOCUMENT_CONTENT_TYPE } from './documentEditorInput.js';

export async function createGeneralDocument(accessor: ServicesAccessor): Promise<void> {
	await resolveGeneralProfile();
	await openDraft(accessor);
}

export async function convertActiveTextToDocument(accessor: ServicesAccessor, format: DocumentTextFormat): Promise<void> {
	const editors = accessor.get(IEditorPart);
	const input = editors.activeInput;
	const model = input && accessor.get(IFileTextModelService).getModel(input.resource);
	if (!input || !model) throw new Error(localize('document.conversion.textRequired', 'Open a text editor before converting its content.'));
	// Package loading and image reads may outlive navigation or further typing.
	const sourceText = model.getValue();
	const ownerDocument = editors.domNode.ownerDocument;
	const profile = (await resolveGeneralProfile()).create();
	const document = profile.importText(sourceText, format, ownerDocument, input.resource);
	const files = accessor.get(IFileService);
	const images = new Map<string, Promise<string>>();
	const materialize = async (node: DocumentNode): Promise<DocumentNode> => {
		if (node.type === 'image' && typeof node.attrs.src === 'string' && !/^(?:https?:|data:)/i.test(node.attrs.src)) {
			let image = images.get(node.attrs.src);
			if (!image) {
				const resource = URI.parse(node.attrs.src);
				const mime = getMediaMime(resource.path);
				if (!mime || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error(localize('document.conversion.unsupported', 'Cannot preserve {0} at {1}.', localize('document.conversion.imageResource', 'image resource'), node.id));
				image = files.readFileBytes(resource).then(value => `data:${mime};base64,${encodeBase64(VSBuffer.wrap(new Uint8Array(value.bytes)))}`);
				images.set(node.attrs.src, image);
			}
			return { ...node, attrs: { ...node.attrs, src: await image } };
		}
		return { ...node, content: await Promise.all(node.content.map(materialize)) };
	};
	const imported = { ...document, content: await Promise.all(document.content.map(materialize)) };
	profile.codec.validate(imported);
	await openDraft(accessor, imported, basename(input.resource).replace(/\.[^.]+$/, ''));
}

export async function exportActiveDocument(accessor: ServicesAccessor, format: DocumentTextFormat): Promise<void> {
	const editors = accessor.get(IEditorPart);
	const pane = editors.activePane;
	if (!(pane instanceof DocumentEditorPane)) throw new Error(localize('document.conversion.documentRequired', 'Open a document before exporting its content.'));
	const copy = pane.workingCopy;
	if (!copy) return;
	const text = pane.exportText(format);
	const extension = format === 'markdown' ? '.md' : '.txt';
	const name = basename(copy.resource).replace(/\.[^.]+$/, '') + extension;
	const untitled = await accessor.get(IUntitledTextEditorService).resolve({
		untitledResource: URI.from({ scheme: 'untitled', path: `/${generateUuid()}/${name}` }),
		initialValue: text, languageId: format === 'markdown' ? 'markdown' : 'plaintext',
	});
	await editors.openEditor(new UntitledTextEditorInput(untitled), { pinned: true });
}

async function openDraft(accessor: ServicesAccessor, document?: DocumentNode, name = localize('document.untitled', 'Untitled')): Promise<void> {
	const editors = accessor.get(IEditorPart);
	const resource = URI.from({ scheme: 'untitled', path: `/${generateUuid()}/${name}.ash-doc` });
	const pane = await editors.openEditor({ resource, contentType: GENERAL_DOCUMENT_CONTENT_TYPE }, { pinned: true });
	if (!(pane instanceof DocumentEditorPane)) throw new Error(localize('document.creation.failed', 'The document editor could not open the new draft.'));
	// Import remains an unsaved draft in the pane's existing dirty/backup lifecycle.
	if (document) pane.restoreDraft(document);
}

async function resolveGeneralProfile() {
	const descriptor = EditorPanes.getEditorPane({ resource: URI.parse('untitled:/document.ash-doc'), contentType: GENERAL_DOCUMENT_CONTENT_TYPE });
	if (!descriptor?.resolveDocumentProfile) throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
	return descriptor.resolveDocumentProfile();
}
