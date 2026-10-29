import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { DocumentTextFormat } from '../../../services/documentEditor/common/documentCodec.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
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
	const editors = accessor.get(IEditorPart);
	await resolveGeneralProfile();
	await openDraft(editors);
}

export async function convertActiveTextToDocument(accessor: ServicesAccessor, format: DocumentTextFormat): Promise<void> {
	const editors = accessor.get(IEditorPart);
	const input = editors.activeInput;
	const model = input && accessor.get(IFileTextModelService).getModel(input.resource);
	const files = accessor.get(IFileService);
	if (!input || !model) throw new Error(localize('document.conversion.textRequired', 'Open a text editor before converting its content.'));
	// Package loading and image reads may outlive navigation or further typing.
	const sourceText = model.getValue();
	const ownerDocument = editors.domNode.ownerDocument;
	const profile = (await resolveGeneralProfile()).create();
	const imported = await profile.importText(sourceText, format, ownerDocument, input.resource, async resource => {
		const value = await files.readFileBytes(resource);
		return new Uint8Array(value.bytes);
	});
	await openDraft(editors, imported, basename(input.resource).replace(/\.[^.]+$/, ''));
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
		initialValue: text,
		languageId: format === 'markdown' ? 'markdown' : 'plaintext',
	});
	await editors.openEditor(new UntitledTextEditorInput(untitled), { pinned: true });
}

async function openDraft(
	editors: IEditorPart,
	document?: DocumentNode,
	name = localize('document.untitled', 'Untitled'),
	contentType = GENERAL_DOCUMENT_CONTENT_TYPE,
	extension = '.ash-doc',
): Promise<void> {
	const resource = URI.from({ scheme: 'untitled', path: `/${generateUuid()}/${name}${extension}` });
	const pane = await editors.openEditor({ resource, contentType }, { pinned: true });
	if (!(pane instanceof DocumentEditorPane)) throw new Error(localize('document.creation.failed', 'The document editor could not open the new draft.'));
	// Import remains an unsaved draft in the pane's existing dirty/backup lifecycle.
	if (document) pane.restoreDraft(document);
}

async function resolveGeneralProfile() {
	const descriptor = EditorPanes.getEditorPane({
		resource: URI.parse('untitled:/document.ash-doc'),
		contentType: GENERAL_DOCUMENT_CONTENT_TYPE,
	});
	if (!descriptor?.resolveDocumentProfile) throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
	return descriptor.resolveDocumentProfile();
}

/** Host-owned target selection and binary IO; the admitted package owns all format semantics. */
export async function exportDocumentArtifact(accessor: ServicesAccessor, formatId?: string): Promise<void> {
	const editors = accessor.get(IEditorPart),
		files = accessor.get(IFileService),
		dialogs = accessor.get(IFileDialogService);
	const pane = editors.activePane;
	if (!(pane instanceof DocumentEditorPane) || !pane.workingCopy) throw new Error(localize('document.conversion.documentRequired', 'Open a document before exporting its content.'));
	const formats = pane.getArtifactFormats();
	const id = formatId ?? (await chooseArtifactFormat(accessor, formats));
	const format = formats.find(format => format.id === id);
	if (!format) return;
	const copy = pane.workingCopy,
		resource = copy.resource;
	const bytes = await pane.exportArtifact(format.id, new AbortController().signal);
	if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const defaultUri =
		resource.scheme === 'file'
			? resource.with({ path: resource.path.replace(/\.[^/.]+$/, '') + '.' + format.extension })
			: URI.file('/' + basename(resource).replace(/\.[^/.]+$/, '') + '.' + format.extension);
	const target = await dialogs.showSaveDialog({
		defaultUri,
		filters: [{ name: format.label, extensions: [format.extension] }],
	});
	if (!target || pane.workingCopy !== copy) return;
	if (target.toString() === resource.toString()) throw new Error(localize('document.output.sourceTarget', 'Choose a separate output file to preserve the open document.'));
	await files.writeFileBytes(target, bytes, { create: true, overwrite: true });
}

export async function importDocumentArtifact(accessor: ServicesAccessor): Promise<void> {
	const files = accessor.get(IFileService),
		dialogs = accessor.get(IFileDialogService),
		editors = accessor.get(IEditorPart);
	const profile = (await resolveGeneralProfile()).create();
	const formats = profile.artifactFormats?.filter(format => format.canImport) ?? [];
	if (!profile.importBinary || !formats.length) throw new Error(localize('document.output.unavailable', 'This document provider does not support the selected output.'));
	const resource = (
		await dialogs.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			filters: formats.map(format => ({ name: format.label, extensions: [format.extension] })),
		})
	)?.[0];
	if (!resource) return;
	const format = formats.find(format => resource.path.toLowerCase().endsWith('.' + format.extension));
	if (!format) throw new Error(localize('document.output.unsupportedInput', 'The selected file format is not supported by this document provider.'));
	if ((await files.stat(resource)).sizeBytes > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const bytes = (await files.readFileBytes(resource)).bytes;
	if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const imported = await profile.importBinary(bytes, format.id, editors.domNode.ownerDocument, new AbortController().signal);
	if (!imported || typeof imported.documentType !== 'string') throw new TypeError('Invalid document import result');
	const descriptor = EditorPanes.getEditorPanes().find(pane => pane.documentType?.id === imported.documentType);
	if (!descriptor?.resolveDocumentProfile || !descriptor.documentType?.extensions[0])
		throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
	const destination = await descriptor.resolveDocumentProfile();
	destination.create().codec.validate(imported.document);
	await openDraft(editors, imported.document, basename(resource).replace(/\.[^.]+$/, ''), destination.contentType, descriptor.documentType.extensions[0]);
}

async function chooseArtifactFormat(accessor: ServicesAccessor, formats: ReturnType<DocumentEditorPane['getArtifactFormats']>): Promise<string | undefined> {
	using store = new DisposableStore();
	const picker = store.add(accessor.get(IQuickInputService).createQuickPick<{ readonly id: string; readonly label: string }>());
	picker.items = formats.map(format => ({ id: format.id, label: format.label }));
	picker.placeholder = picker.ariaLabel = localize('document.output.choose', 'Choose document output format');
	return await new Promise(resolve => {
		store.add(
			picker.onDidAccept(() => {
				resolve((picker.selectedItems[0] ?? picker.activeItems[0])?.id);
				picker.hide();
			}),
		);
		store.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
}
