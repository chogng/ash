import { localize } from '../../../../nls.js';
import type { URI } from '../../../../base/common/uri.js';
import type { DocumentNode } from '../../../../../../extensions/academic/common/model/document.js';
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { AbstractDisposable, Disposable, DisposableMap } from "../../../../base/common/lifecycle.js";
import { extUri } from '../../../../base/common/resources.js';
import type { DocumentTextModel } from "../../../../../../extensions/academic/common/model/documentTextModel.js";
import type { TextModelBlockInput, TextModelWorkingCopyReference } from "../../textmodelResolver/common/textModelResourceService.js";
import { ITextFileService } from "../../textfile/common/textfiles.js";
import { IWorkingCopyService } from "../../workingCopy/common/workingCopyService.js";
import type { IDocumentEditorTextModelService } from '../common/documentTypes.js';
import { DocumentWorkingCopy } from "./documentWorkingCopy.js";

/** Workbench persistence adapter for a DocumentTextModel opened by the document editor. */
export class DocumentEditorTextModelService extends Disposable implements IDocumentEditorTextModelService {
	private readonly entries = this._register(new DisposableMap<string, DocumentModelEntry>());

	constructor(@ITextFileService private readonly textFiles: ITextFileService, @IWorkingCopyService private readonly workingCopyService: IWorkingCopyService) {
		super();
	}

	async acquire(input: TextModelBlockInput, signal: AbortSignal): Promise<TextModelWorkingCopyReference> {
		this.assertNotDisposed();
		throwIfCancelled(signal, "Stanza document editor TextModel acquisition was cancelled");
		if (!input.contentType) { throw new TypeError('Document acquisition requires a content type'); }
		const key = extUri.getComparisonKey(input.resource);
		const existing = this.entries.get(key);
		if (existing) { return this.reference(key, existing, input); }
		// Untitled documents have no file provider. Their durable content comes from
		// a working-copy backup or the collaboration room after the pane opens.
		const initialText = input.initialText ?? (input.resource.scheme === 'untitled' ? '' : undefined);
		const content = await this.textFiles.resolve({
			resource: input.resource,
			...(initialText === undefined ? {} : { bootstrapText: initialText }),
		}, signal);
		throwIfCancelled(signal, "Stanza document editor TextModel acquisition was cancelled");
		this.assertNotDisposed();
		const concurrent = this.entries.get(key);
		if (concurrent) { return this.reference(key, concurrent, input); }
		const document = input.codec.parse(content.text, input.schema, input.createEmptyDocument);
		const model = input.codec.createModel(input.schema, document, input.plugins);
		const workingCopy: DocumentWorkingCopy = new DocumentWorkingCopy({
			codec: input.codec,
			contentType: input.contentType,
			resource: input.resource,
			model,
			initialDocument: document,
			initialRevision: content.revision,
			textFiles: this.textFiles,
			workingCopyService: this.workingCopyService,
			onSave: () => entry.saveUntitled(),
			createEmptyDocument: input.createEmptyDocument,
		});
		const entry = new DocumentModelEntry(model, workingCopy, input.modelCompatibility ?? input.schema.documentType);
		this.entries.set(key, entry);
		return this.reference(key, entry, input);
	}

	acceptCollaborationSnapshot(resource: URI, document: DocumentNode): void {
		this.entries.get(extUri.getComparisonKey(resource))?.workingCopy.acceptCollaborationSnapshot(document);
	}

	private reference(key: string, entry: DocumentModelEntry, input: TextModelBlockInput): TextModelWorkingCopyReference {
		if (entry.workingCopy.backupContentType !== input.contentType || entry.model.schema.documentType !== input.schema.documentType) { throw new Error('The resource is already open with a different document type'); }
		if (entry.compatibility !== (input.modelCompatibility ?? input.schema.documentType)) {
			throw new Error(localize('document.model.incompatible', 'The document is open with a different editor version. Save or recover its existing content before reopening it.'));
		}
		entry.references += 1;
		const reference = new TextModelWorkingCopyReferenceImpl(entry.model, entry.workingCopy, () => {
			entry.saveHandlers.delete(reference);
			entry.references -= 1;
			if (entry.references === 0 && this.entries.get(key) === entry) { this.entries.deleteAndDispose(key); }
		});
		if (input.onSave) { entry.saveHandlers.set(reference, input.onSave); }
		return reference;
	}
}

class DocumentModelEntry extends Disposable {
	public references = 0;
	public readonly saveHandlers = new Map<TextModelWorkingCopyReference, () => Promise<void | boolean>>();
	constructor(public readonly model: DocumentTextModel, public readonly workingCopy: DocumentWorkingCopy, public readonly compatibility: string) {
		super();
		this._register(model);
		this._register(workingCopy);
	}

	// Untitled Save As belongs to a live view. Closing the first view must not leave
	// the shared working copy calling a disposed editor group's save handler.
	public saveUntitled(): Promise<void | boolean> {
		const handler = [...this.saveHandlers.values()].at(-1);
		if (!handler) { throw new Error('Untitled document has no save handler'); }
		return handler();
	}
}

class TextModelWorkingCopyReferenceImpl extends AbstractDisposable implements TextModelWorkingCopyReference {
	readonly resource;
	readonly model;
	readonly onDidChangeDirty;
	readonly onDidChangeExternalChange;
	readonly onDidChangeContent;
	readonly backupKind;
	readonly backupContentType;

	constructor(model: DocumentTextModel, private readonly workingCopy: DocumentWorkingCopy, private readonly release: () => void) {
		super();
		this.model = model;
		this.resource = workingCopy.resource;
		this.onDidChangeDirty = workingCopy.onDidChangeDirty;
		this.onDidChangeExternalChange = workingCopy.onDidChangeExternalChange;
		this.onDidChangeContent = workingCopy.onDidChangeContent;
		this.backupKind = workingCopy.backupKind;
		this.backupContentType = workingCopy.backupContentType;
	}

	protected override disposeCore(): void { this.release(); }

	get isDirty(): boolean {
		return this.workingCopy.isDirty;
	}

	get hasExternalChange(): boolean {
		return this.workingCopy.hasExternalChange;
	}

	backup(): string {
		return this.workingCopy.backup();
	}

	restoreBackup(content: string): void {
		this.workingCopy.restoreBackup(content);
	}

	save(signal: AbortSignal): Promise<void> {
		return this.workingCopy.save(signal);
	}

	saveAs(resource: TextModelWorkingCopyReference["resource"], signal: AbortSignal): Promise<void> {
		return this.workingCopy.saveAs(resource, signal);
	}

	revert(signal: AbortSignal): Promise<void> {
		return this.workingCopy.revert(signal);
	}
}
