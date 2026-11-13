import { Schemas } from '../../../../base/common/network.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { DocumentTextFormat } from '../../../../workbench/services/documentEditor/common/documentCodec.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileTextModelService } from '../../../../workbench/services/textmodelResolver/common/textModelResourceService.js';
import { IUntitledTextEditorService } from '../../../../workbench/services/untitled/common/untitledTextEditorService.js';
import { UntitledTextEditorInput } from '../../../../workbench/services/untitled/common/untitledTextEditorInput.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import type { DocumentNode } from '../../../../workbench/services/documentEditor/common/documentCodec.js';
import { localize } from '../../../../nls.js';
import { DocumentEditorPane } from '../../../../workbench/contrib/documentEditor/browser/documentEditorPane.js';
import { EditorPanes } from '../../../../workbench/browser/editor.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { saveResourceAs } from '../../../../workbench/services/files/browser/resourceSave.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';
import { artifactDetailEntry } from '../../artifact/common/artifactWorkspace.js';
import { DOCS_ARTIFACT_EDITOR_ID, DOCS_MARKDOWN_EDITOR_ID, DOCS_TOOLS_CONTAINER_ID, GENERAL_DOCUMENT_CONTENT_TYPE } from '../common/docs.js';

export const ARTIFACT_EXAMPLE_SCHEME = 'ash-artifact-example';

export async function createGeneralDocument(accessor: ServicesAccessor): Promise<void> {
	await createDocsOpener(accessor)(newDocsResource(localize('document.untitled', 'Untitled')));
}

const activeDocsKey = 'sessions.creator.activeDocument';

export function restoredDocsResource(storage: IStorageService): URI | undefined {
	const saved = storage.get(activeDocsKey, StorageScope.WORKSPACE);
	if (!saved) return undefined;
	const resource = URI.parse(saved);
	return [Schemas.file, Schemas.untitled, Schemas.vscodeUserData].includes(resource.scheme) && /\.(?:ash-doc|md)$/iu.test(resource.path) ? resource : undefined;
}

export function newDocsResource(name: string, extension = '.ash-doc'): URI {
	return URI.from({ scheme: 'untitled', path: `/${generateUuid()}/${name}${extension}` });
}

export function createDocsInput(source: IResourceEditorInput): IResourceEditorInput {
	if (source.rename) return source;
	return {
		...source,
		editorId: DOCS_ARTIFACT_EDITOR_ID,
		contentType: GENERAL_DOCUMENT_CONTENT_TYPE,
		showBreadcrumbs: false,
		rename: target => createDocsInput({ resource: target }),
	};
}

export function createMarkdownDocsInput(source: IResourceEditorInput): IResourceEditorInput {
	if (source.editorId === DOCS_MARKDOWN_EDITOR_ID && source.rename) return source;
	return {
		...source, editorId: DOCS_MARKDOWN_EDITOR_ID, languageId: 'markdown', contentType: 'text/markdown', showBreadcrumbs: false,
		...(source.resource.scheme === 'untitled' ? { initialText: source.initialText ?? '' } : {}),
		rename: resource => createMarkdownDocsInput({ resource }),
	};
}

export function createDocsOpener(accessor: ServicesAccessor) {
	const editors = accessor.get(IEditorPart);
	const storage = accessor.get(IStorageService);
	const layout = accessor.get(ISessionsEntryService);
	const remember = (resource: URI) => storage.store(activeDocsKey, resource.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	return async (resource: URI, options: { source?: 'restore'; label?: string; initialText?: string; document?: DocumentNode; } = {}) => {
		const example = resource.scheme === ARTIFACT_EXAMPLE_SCHEME;
		const rich = resource.path.toLowerCase().endsWith('.ash-doc');
		const input = rich ? createDocsInput({ resource, label: options.label, readOnly: example, initialText: options.initialText })
			: createMarkdownDocsInput({ resource, label: options.label });
		const entry = {
			...artifactDetailEntry, id: example ? 'creator.example.docs' : 'creator.docs',
			detailsContainerId: rich ? DOCS_TOOLS_CONTAINER_ID : undefined,
			restoreCommand: example ? 'sessions.show.creator' : 'sessions.restore.creatorDocs',
			editorInput: input,
			onEditorInputReplaced: (previous: IResourceEditorInput, replacement: IResourceEditorInput) => {
				if (storage.get(activeDocsKey, StorageScope.WORKSPACE) === previous.resource.toString()) remember(replacement.resource);
			},
		} as const;
		await layout.openEntry(entry, () => {
			if (options.document) {
				const pane = editors.activePane;
				if (!(pane instanceof DocumentEditorPane) || pane.workingCopy?.resource.toString() !== resource.toString()) {
					throw new Error(localize('document.creation.failed', 'The document editor could not open the new draft.'));
				}
				pane.restoreDraft(options.document);
			}
			if (!example) remember(resource);
			return entry;
		}, { source: options.source });
	};
}

export async function openWritingDraft(accessor: ServicesAccessor, html: string, title?: string): Promise<void> {
	const open = createDocsOpener(accessor);
	const editors = accessor.get(IEditorPart);
	const { importGeneralDocumentHtml } = await import('../../../../../../extensions/academy/browser/generalProfile.js');
	const document = importGeneralDocumentHtml(html, editors.domNode.ownerDocument);
	if (!document) throw new Error(localize('sessions.artifacts.writingImportFailed', 'This writing block could not be opened in Docs.'));
	// Provider titles are untrusted display text, but this name also becomes the proposed filename.
	const safeTitle = title?.replace(/[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').trim();
	const name = safeTitle && Array.from(safeTitle).slice(0, 60).join('').trimEnd();
	await open(newDocsResource(name || localize('sessions.artifacts.untitledDocument', 'Untitled document')), { document });
}

export async function convertActiveTextToDocument(accessor: ServicesAccessor, format: DocumentTextFormat): Promise<void> {
	const open = createDocsOpener(accessor);
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
	await open(newDocsResource(basename(input.resource).replace(/\.[^.]+$/, '')), { document: imported });
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

async function openDraft(editors: IEditorPart, document?: DocumentNode, name = localize('document.untitled', 'Untitled'), contentType = GENERAL_DOCUMENT_CONTENT_TYPE, extension = '.ash-doc'): Promise<void> {
	const resource = URI.from({ scheme: 'untitled', path: `/${generateUuid()}/${name}${extension}` });
	const pane = await editors.openEditor({ resource, contentType }, { pinned: true });
	if (!(pane instanceof DocumentEditorPane)) throw new Error(localize('document.creation.failed', 'The document editor could not open the new draft.'));
	// Import remains an unsaved draft in the pane's existing dirty/backup lifecycle.
	if (document) {
		pane.restoreDraft(document);
		pane.focus();
	}
}

async function resolveGeneralProfile() {
	const descriptor = EditorPanes.getEditorPane({ resource: URI.parse('untitled:/document.ash-doc'), contentType: GENERAL_DOCUMENT_CONTENT_TYPE });
	if (!descriptor?.resolveDocumentProfile) throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
	return descriptor.resolveDocumentProfile();
}

/** Host-owned target selection and binary IO; the admitted package owns all format semantics. */
export async function exportDocumentArtifact(accessor: ServicesAccessor, formatId?: string): Promise<void> {
	const editors = accessor.get(IEditorPart), dialogs = accessor.get(IFileDialogService);
	const instantiation = accessor.get(IInstantiationService);
	const pane = editors.activePane;
	if (!(pane instanceof DocumentEditorPane) || !pane.workingCopy) throw new Error(localize('document.conversion.documentRequired', 'Open a document before exporting its content.'));
	const formats = pane.getArtifactFormats();
	const id = formatId ?? await chooseArtifactFormat(accessor, formats);
	const format = formats.find(format => format.id === id); if (!format) return;
	const copy = pane.workingCopy, resource = copy.resource;
	const bytes = await pane.exportArtifact(format.id, new AbortController().signal);
	if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const defaultUri = resource.scheme === 'file' ? resource.with({ path: resource.path.replace(/\.[^/.]+$/, '') + '.' + format.extension }) : URI.file('/' + basename(resource).replace(/\.[^/.]+$/, '') + '.' + format.extension);
	await instantiation.invokeFunction(saveResourceAs, bytes, basename(defaultUri), editors.domNode.ownerDocument, {
		selectTarget: async () => {
			const target = await dialogs.showSaveDialog({ defaultUri, filters: [{ name: format.label, extensions: [format.extension] }] });
			if (!target || pane.workingCopy !== copy) return undefined;
			if (target.toString() === resource.toString()) throw new Error(localize('document.output.sourceTarget', 'Choose a separate output file to preserve the open document.'));
			return target;
		},
	});
}

export async function importDocumentArtifact(accessor: ServicesAccessor): Promise<void> {
	const open = createDocsOpener(accessor);
	const files = accessor.get(IFileService), dialogs = accessor.get(IFileDialogService), editors = accessor.get(IEditorPart);
	const profile = (await resolveGeneralProfile()).create();
	const formats = profile.artifactFormats?.filter(format => format.canImport) ?? [];
	if (!profile.importBinary || !formats.length) throw new Error(localize('document.output.unavailable', 'This document provider does not support the selected output.'));
	const resource = (await dialogs.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: formats.map(format => ({ name: format.label, extensions: [format.extension] })) }))?.[0];
	if (!resource) return;
	const format = formats.find(format => resource.path.toLowerCase().endsWith('.' + format.extension));
	if (!format) throw new Error(localize('document.output.unsupportedInput', 'The selected file format is not supported by this document provider.'));
	if ((await files.stat(resource)).sizeBytes > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const bytes = (await files.readFileBytes(resource)).bytes;
	if (!(bytes instanceof Uint8Array) || bytes.length > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
	const imported = await profile.importBinary(bytes, format.id, editors.domNode.ownerDocument, new AbortController().signal);
	if (!imported || typeof imported.documentType !== 'string') throw new TypeError('Invalid document import result');
	const descriptor = EditorPanes.getEditorPanes().find(pane => pane.documentType?.id === imported.documentType);
	if (!descriptor?.resolveDocumentProfile || !descriptor.documentType?.extensions[0]) throw new Error(localize('extensions.clientEditor.packageUnavailable', 'The editor extension package is unavailable.'));
	const destination = await descriptor.resolveDocumentProfile();
	destination.create().codec.validate(imported.document);
	const name = basename(resource).replace(/\.[^.]+$/, '');
	if (destination.contentType === GENERAL_DOCUMENT_CONTENT_TYPE) {
		await open(newDocsResource(name), { document: imported.document });
	} else {
		await openDraft(editors, imported.document, name, destination.contentType, descriptor.documentType.extensions[0]);
	}
}

async function chooseArtifactFormat(accessor: ServicesAccessor, formats: ReturnType<DocumentEditorPane['getArtifactFormats']>): Promise<string | undefined> {
	using store = new DisposableStore();
	const picker = store.add(accessor.get(IQuickInputService).createQuickPick<{ readonly id: string; readonly label: string; }>());
	picker.items = formats.map(format => ({ id: format.id, label: format.label }));
	picker.placeholder = picker.ariaLabel = localize('document.output.choose', 'Choose document output format');
	return await new Promise(resolve => {
		store.add(picker.onDidAccept(() => { resolve((picker.selectedItems[0] ?? picker.activeItems[0])?.id); picker.hide(); }));
		store.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
}
