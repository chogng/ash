import type { DocumentCodec } from '../common/documentCodec.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { type URI } from '../../../../base/common/uri.js';
import { type DocumentNode } from '../common/documentCodec.js';
import type { DocumentTextModel } from '../common/documentCodec.js';
import { TextFileSaveConflictError } from '../../textfile/common/textFileService.js';
import type { ITextFileService } from '../../textfile/common/textfiles.js';
import type { IWorkingCopy } from '../../workingCopy/common/workingCopyService.js';
import type { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { DocumentTypes } from '../common/documentTypes.js';
import { localize } from '../../../../nls.js';

export interface DocumentWorkingCopyOptions {
	readonly codec: DocumentCodec;
	readonly contentType: string;
	readonly resource: URI;
	readonly model: DocumentTextModel;
	readonly initialDocument: DocumentNode;
	readonly initialRevision: string | undefined;
	readonly textFiles: ITextFileService;
	readonly workingCopyService: IWorkingCopyService;
	readonly onSave?: () => Promise<void | boolean>;
	/** Creates the canonical document when the persisted resource is empty. */
	readonly createEmptyDocument?: () => DocumentNode;
}

/** Persistence adapter for Group/Block metadata owned by Stanza's DocumentTextModel. */
export class DocumentWorkingCopy extends Disposable implements IWorkingCopy {
	private readonly dirtyEmitter = this._register(new Emitter<void>());
	private readonly externalChangeEmitter = this._register(new Emitter<void>());
	private initialDocument: DocumentNode;
	private initialContent: string;
	private savedContent: string;
	private revision: string | undefined;
	private dirty = false;
	private externalChange = false;
	private saveQueue: Promise<void> = Promise.resolve();

	readonly resource: URI;
	readonly backupKind = 'structuredDocument' as const;
	readonly backupContentType: string;
	readonly onDidChangeDirty = this.dirtyEmitter.event;
	readonly onDidChangeExternalChange = this.externalChangeEmitter.event;
	readonly onDidChangeContent = (listener: () => void) => this.options.model.onDidChangeBlocks(() => listener());

	constructor(private readonly options: DocumentWorkingCopyOptions) {
		super();
		this.resource = options.resource;
		this.backupContentType = options.contentType;
		this.initialDocument = options.initialDocument;
		this.initialContent = this.options.codec.serialize(options.initialDocument);
		this.savedContent = this.initialContent;
		this.revision = options.initialRevision;
		this._register(options.model.onDidChangeBlocks(() => this.refreshDirty()));
		this._register(
			options.textFiles.onDidChangeFiles(event => {
				if (this.resource.scheme === 'untitled' || (event.resources && !event.resources.some(resource => resource.toString() === this.resource.toString()))) return;
				if (this.isDirty) {
					this.setExternalChange(true);
					return;
				}
				void this.reloadCleanDocument();
			}),
		);
		this._register(options.workingCopyService.register(this));
	}

	get isDirty(): boolean {
		return this.dirty;
	}

	get hasExternalChange(): boolean {
		return this.externalChange;
	}

	backup(): string {
		return this.options.codec.serialize(this.options.model.document);
	}

	restoreBackup(content: string): void {
		this.options.model.resetBlocks(this.options.codec.parse(content, this.options.createEmptyDocument));
	}

	acceptCollaborationSnapshot(document: DocumentNode): void {
		this.savedContent = this.options.codec.serialize(document);
		// Discarding local edits in a channel returns to the last confirmed version,
		// rather than to the empty document used before joining the room.
		this.initialDocument = document;
		this.initialContent = this.savedContent;
		this.refreshDirty();
	}

	save(signal: AbortSignal): Promise<void> {
		const operation = this.saveQueue.then(() => this.saveContent(signal));
		this.saveQueue = operation.catch(() => undefined);
		return operation;
	}

	private async saveContent(signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, 'Document save was cancelled');
		if (this.resource.scheme === 'untitled') {
			if (!this.options.onSave) throw new Error('Untitled document has no save handler');
			const result = await this.options.onSave();
			// Save As may replace every view and retire this resource's shared model.
			// The destination working copy owns the saved baseline after that transfer.
			if (result === false || this.isDisposed) return;
			this.savedContent = this.options.codec.serialize(this.options.model.document);
			this.refreshDirty();
			this.setExternalChange(false);
			return;
		}
		const serialized = this.options.codec.serialize(this.options.model.document);
		let saved;
		try {
			saved = await this.options.textFiles.save(
				{
					resource: this.resource,
					text: serialized,
					...(this.revision === undefined ? {} : { expectedRevision: this.revision }),
				},
				signal,
			);
		} catch (error) {
			if (error instanceof TextFileSaveConflictError) this.setExternalChange(true);
			throw error;
		}
		this.savedContent = serialized;
		this.revision = saved.revision;
		this.refreshDirty();
		this.setExternalChange(false);
	}

	async saveAs(resource: URI, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, 'Document Save As was cancelled');
		const type = DocumentTypes.find({ resource: this.resource, contentType: this.backupContentType });
		if (type && DocumentTypes.find({ resource })?.id !== type.id) {
			// Renaming must not turn a structured working copy into a plain-text view.
			// Explicit conversion commands create the destination's actual format.
			throw new Error(localize('document.saveAs.type', 'Save this document with a supported extension ({0}). Use an explicit conversion command to change formats.', type.extensions.join(', ')));
		}
		const serialized = this.options.codec.serialize(this.options.model.document);
		await this.options.textFiles.save({ resource, text: serialized }, signal);
		this.savedContent = serialized;
		this.refreshDirty();
		this.setExternalChange(false);
	}

	async revert(signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, 'Document revert was cancelled');
		if (this.resource.scheme === 'untitled') {
			this.savedContent = this.initialContent;
			this.options.model.resetBlocks(this.initialDocument);
			this.setExternalChange(false);
			return;
		}
		const content = await this.options.textFiles.resolve({ resource: this.resource }, signal);
		throwIfCancelled(signal, 'Document revert was cancelled');
		const document = this.options.codec.parse(content.text, this.options.createEmptyDocument);
		this.savedContent = this.options.codec.serialize(document);
		this.revision = content.revision;
		this.options.model.resetBlocks(document);
		this.setExternalChange(false);
	}

	private async reloadCleanDocument(): Promise<void> {
		try {
			const content = await this.options.textFiles.resolve({ resource: this.resource }, new AbortController().signal);
			if (this.isDirty) {
				this.setExternalChange(true);
				return;
			}
			const document = this.options.codec.parse(content.text, this.options.createEmptyDocument);
			this.savedContent = this.options.codec.serialize(document);
			this.revision = content.revision;
			this.options.model.resetBlocks(document);
			this.setExternalChange(false);
		} catch {
			this.setExternalChange(true);
		}
	}

	private refreshDirty(): void {
		const dirty = this.options.codec.serialize(this.options.model.document) !== this.savedContent;
		if (this.dirty === dirty) return;
		this.dirty = dirty;
		this.dirtyEmitter.fire();
	}

	private setExternalChange(value: boolean): void {
		if (this.externalChange === value) return;
		this.externalChange = value;
		this.externalChangeEmitter.fire();
	}
}
