import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { AbstractDisposable, Disposable, DisposableMap } from "../../../../base/common/lifecycle.js";
import { extUri } from '../../../../base/common/resources.js';
import { TextModel } from "../../../../editor/common/model/textModel.js";
import type { TextModelBlockInput, TextModelWorkingCopyReference } from "../../textmodelResolver/common/textModelResourceService.js";
import { ITextFileService } from "../../textfile/common/textFileService.js";
import { IWorkingCopyService } from "../../workingCopy/common/workingCopyService.js";
import type { IDocumentEditorTextModelService } from '../common/documentTypes.js';
import { DocumentWorkingCopy } from "./documentWorkingCopy.js";
import { parseDocument } from "./documentWorkingCopy.js";

/** Workbench persistence adapter for a TextModel opened by the document editor. */
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
		const content = await this.textFiles.resolve({
			resource: input.resource,
			...(input.initialText === undefined ? {} : { bootstrapText: input.initialText }),
		}, signal);
		throwIfCancelled(signal, "Stanza document editor TextModel acquisition was cancelled");
		this.assertNotDisposed();
		const concurrent = this.entries.get(key);
		if (concurrent) { return this.reference(key, concurrent, input); }
		const document = parseDocument(content.text, input.schema, input.createEmptyDocument);
		const model = TextModel.create(input.schema, document, { plugins: input.plugins });
		const workingCopy: DocumentWorkingCopy = new DocumentWorkingCopy({
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
		const entry = new DocumentModelEntry(model, workingCopy);
		this.entries.set(key, entry);
		return this.reference(key, entry, input);
	}

	private reference(key: string, entry: DocumentModelEntry, input: TextModelBlockInput): TextModelWorkingCopyReference {
		if (entry.workingCopy.backupContentType !== input.contentType) { throw new Error('The resource is already open with a different document type'); }
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
	constructor(public readonly model: TextModel, public readonly workingCopy: DocumentWorkingCopy) {
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

	constructor(model: TextModel, private readonly workingCopy: DocumentWorkingCopy, private readonly release: () => void) {
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
