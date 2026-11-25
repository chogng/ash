import { assert } from '../../../../base/common/assert.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { structuralEquals } from '../../../../base/common/equals.js';
import { Emitter } from '../../../../base/common/event.js';
import { isValidBasename } from '../../../../base/common/extpath.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { extname } from '../../../../base/common/path.js';
import { basename } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { FileRevisionConflictError, FileSystemProviderErrorCode, IFileService, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { IPdfService, type IPdfDocument, type PdfAnnotationEdit, type PdfOutlineEntry, type PdfPage } from '../../../../platform/pdf/common/pdfService.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../../workbench/common/editor.js';
import type { IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { localize } from '../../../../nls.js';

interface PdfEdit { readonly page: number; readonly edit: PdfAnnotationEdit; }
interface PdfCheckpoint { readonly source: Uint8Array; readonly editCount: number; }
interface PdfRebuild { readonly document: IPdfDocument; readonly page: PdfPage; readonly checkpoint: PdfCheckpoint | undefined; }
interface PdfBackup {
	readonly source: Uint8Array;
	readonly edits: PdfEdit[];
	readonly revision?: string;
	readonly savedEdits?: readonly PdfEdit[];
	readonly copyOnly: boolean;
}

const backupVersion = 2;
const maxBackupEdits = 1000;
const maxPdfBytes = 64 * 1024 * 1024;
const maxResidentOriginalBytes = 1024 * 1024;

/** Owns the editor's draft, undo history and file revision; the native session is a derived snapshot. */
export class PdfDocumentModel extends Disposable implements IWorkingCopy {
	public readonly backupKind = 'structuredDocument';
	public readonly backupContentType = 'application/pdf';
	public readonly backupLabel = 'aspdf';
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeContent = this.changed.event;
	private readonly reverted = this._register(new Emitter<void>());
	public readonly onDidRevert = this.reverted.event;
	public readonly onDidChangeDirty = this.changed.event;
	public readonly onDidChangeExternalChange = this.changed.event;
	private readonly lifetime = new AbortController();
	private document: IPdfDocument | undefined;
	private source: Uint8Array | undefined;
	private fileRevision: string | undefined;
	private sourceFileReadOnly = false;
	private sourceUnavailable = false;
	private edits: PdfEdit[] = [];
	private undone: PdfEdit[] = [];
	private savedEdits: readonly PdfEdit[] | undefined = [];
	private checkpoint: PdfCheckpoint | undefined;
	private failedRecovery: { readonly content: string; readonly error: unknown; } | undefined;
	private pending: Promise<unknown> = Promise.resolve();
	public current: PdfPage | undefined;
	public hasExternalChange = false;

	constructor(
		private readonly input: IResourceEditorInput,
		@IFileService private readonly files: IFileService,
		@IPdfService private readonly pdf: IPdfService,
		@IFileDialogService private readonly dialogs: Pick<IFileDialogService, 'showSaveDialog'>,
	) {
		super();
		this._register(toDisposable(() => { this.lifetime.abort(); this.document?.dispose(); }));
	}

	public get resource(): URI { return this.input.resource; }
	public get isDirty(): boolean {
		// A backup without a saved history still represents an unsaved draft.
		return this.failedRecovery !== undefined || this.savedEdits === undefined || !structuralEquals(this.savedEdits, this.edits);
	}
	public get canUndo(): boolean { return this.edits.length > 0; }
	public get canRedo(): boolean { return this.undone.length > 0; }
	public get savesCopy(): boolean { return this.sourceFileReadOnly || this.sourceUnavailable || this.input.initialBytes !== undefined; }
	public get recoveryError(): unknown { return this.failedRecovery?.error; }

	public open(readBackup?: () => Promise<string | undefined>): Promise<void> {
		return this.serialize(async () => {
			const signal = this.lifetime.signal;
			try {
				if (!this.input.initialBytes) {
					const stat = await this.files.stat(this.resource);
					if (stat.sizeBytes > maxPdfBytes) { throw new Error(localize('sessions.pdfPreview.tooLarge', 'PDFs larger than 64 MiB cannot be opened.')); }
					this.sourceFileReadOnly = stat.readonly;
				}
				const { document, revision, source } = await this.openFile(signal);
				this.document = document;
				this.source = source;
				this.fileRevision = revision;
			} catch (error) {
				signal.throwIfAborted();
				const code = error instanceof Error ? toFileSystemProviderErrorCode(error) : undefined;
				if (!readBackup || (code !== FileSystemProviderErrorCode.FileNotFound && code !== FileSystemProviderErrorCode.Unavailable)) throw error;
				const content = await readBackup();
				if (content === undefined) throw error;
				const backup = parseBackup(content);
				// Response bytes can disappear with the conversation row or renderer.
				// The draft can still be reopened without acquiring a writable origin.
				if (!backup.copyOnly) throw error;
				await this.applyBackup(backup);
				this.sourceUnavailable = true;
				this.changed.fire();
			}
		});
	}

	private async openFile(signal: AbortSignal): Promise<{ document: IPdfDocument; revision?: string; source?: Uint8Array; }> {
		if (this.input.initialBytes) {
			const source = this.input.initialBytes;
			return { document: await this.pdf.open(source, signal), source };
		}
		const snapshot = await this.pdf.openSnapshot?.(
			async owner => this.files.openReadSnapshot?.(this.resource, owner, signal), signal,
		);
		if (snapshot) { return snapshot; }
		const file = await this.files.readFileBytes(this.resource);
		signal.throwIfAborted();
		const document = await this.pdf.open(file.bytes, signal);
		return { document, revision: file.revision, source: file.bytes.byteLength <= maxResidentOriginalBytes ? file.bytes : undefined };
	}

	public render(number: number, edit?: PdfAnnotationEdit, preview?: { readonly dimension: number; readonly signal?: AbortSignal; }): Promise<{ page: PdfPage; bytes: Uint8Array; }> {
		return this.serialize(async () => {
			if (edit && this.failedRecovery) { throw this.failedRecovery.error; }
			const document = this.document!;
			const signal = preview?.signal && !edit ? AbortSignal.any([this.lifetime.signal, preview.signal]) : this.lifetime.signal;
			signal.throwIfAborted();
			// The server's unmodified snapshot remains valid even if the file on disk changes.
			// The first edit fetches uncached original bytes for undo and crash recovery.
			const source = edit && !this.source
				? await document.export(this.current ?? await document.page(number, 1600, signal), signal)
				: this.source;
			const checkpoint = edit ? await this.checkpointForNextEdit() : this.checkpoint;
			const page = await document.page(number, preview?.dimension ?? 1600, signal, edit);
			if (edit) {
				this.current = page;
				this.source = source;
				this.checkpoint = checkpoint;
				this.edits.push({ page: number, edit });
				this.undone = [];
				this.changed.fire();
			}
			const bytes = await document.image(page, signal);
			signal.throwIfAborted();
			this.current = page;
			return { page, bytes };
		});
	}

	public readOutline(signal: AbortSignal): Promise<readonly PdfOutlineEntry[]> {
		return this.serialize(async () => {
			const operation = AbortSignal.any([this.lifetime.signal, signal]);
			operation.throwIfAborted();
			return this.document?.outline?.(operation) ?? [];
		});
	}

	/** Renders the working snapshot without changing the page used by editing and saving. */
	public renderThumbnail(number: number, signal: AbortSignal): Promise<Pick<PdfPage, 'width' | 'height' | 'widthPoints' | 'heightPoints'> & { bytes: Uint8Array; }> {
		return this.serialize(async () => {
			const operation = AbortSignal.any([this.lifetime.signal, signal]);
			operation.throwIfAborted();
			const document = this.document!;
			const page = await document.page(number, 256, operation);
			const { width, height, widthPoints, heightPoints } = page;
			return { width, height, widthPoints, heightPoints, bytes: await document.image(page, operation) };
		});
	}

	public undo(): Promise<void> {
		return this.serialize(async () => {
			const edit = this.edits.at(-1);
			if (!edit) { return; }
			if (this.failedRecovery) { throw this.failedRecovery.error; }
			this.install(await this.rebuild(this.originalSource(), this.edits.slice(0, -1), this.checkpoint));
			this.edits.pop(); this.undone.push(edit); this.changed.fire();
		});
	}

	public redo(): Promise<void> {
		return this.serialize(async () => {
			const edit = this.undone.at(-1);
			if (!edit) { return; }
			if (this.failedRecovery) { throw this.failedRecovery.error; }
			const checkpoint = await this.checkpointForNextEdit();
			this.install(await this.rebuild(this.originalSource(), [...this.edits, edit], checkpoint));
			this.undone.pop(); this.edits.push(edit); this.changed.fire();
		});
	}

	public save(signal: AbortSignal, _options?: ISaveOptions): Promise<void> {
		return this.serialize(async () => {
			if (!this.current || !this.isDirty) { return; }
			// A failed replay leaves the previously opened native snapshot in place.
			if (this.failedRecovery) { throw this.failedRecovery.error; }
			const operation = AbortSignal.any([signal, this.lifetime.signal]);
			operation.throwIfAborted();
			const target = this.savesCopy ? await this.pickCopyTarget() : this.resource;
			if (!target) { return; }
			operation.throwIfAborted();
			const bytes = await this.document!.export(this.current, operation);
			try {
				const options = this.savesCopy ? { create: true, overwrite: false }
					: { create: false, overwrite: true, expectedRevision: this.fileRevision };
				const result = await this.files.writeFileBytes(target, bytes, options, operation);
				if (!this.savesCopy) this.fileRevision = result.revision;
				this.savedEdits = this.edits.slice();
				this.hasExternalChange = false; this.changed.fire();
			} catch (error) {
				if (error instanceof FileRevisionConflictError) { this.hasExternalChange = true; this.changed.fire(); }
				throw error;
			}
		});
	}

	private pickCopyTarget(): Promise<URI | undefined> {
		const name = basename(this.resource);
		const filename = !isValidBasename(name) ? 'document.pdf' : extname(name).toLowerCase() === '.pdf' ? name : `${name}.pdf`;
		return this.dialogs.showSaveDialog({
			title: localize('sessions.pdfPreview.saveCopy', 'Save a copy'),
			defaultUri: URI.file(`/${filename}`),
		});
	}

	public saveAs(resource: URI, signal: AbortSignal): Promise<void> {
		return this.serialize(async () => {
			if (!this.current) { return; }
			if (this.failedRecovery) { throw this.failedRecovery.error; }
			const bytes = await this.document!.export(this.current, signal);
			await this.files.writeFileBytes(resource, bytes, { create: true, overwrite: false }, signal);
		});
	}

	public revert(signal: AbortSignal): Promise<void> {
		return this.serialize(async () => {
			signal.throwIfAborted();
			// A response can release its provider entry while the editor is still open.
			if (this.savesCopy && this.source && (this.sourceUnavailable || !this.failedRecovery)) {
				const saved = this.savedEdits ?? [];
				this.install(await this.rebuild(this.source, saved));
				this.edits = saved.slice();
				this.savedEdits = saved;
				this.undone = [];
				this.reverted.fire();
				this.changed.fire();
				return;
			}
			const operationSignal = AbortSignal.any([signal, this.lifetime.signal]);
			const { document, revision, source } = await this.openFile(operationSignal);
			try {
				const page = await document.page(this.current?.page ?? 1, 1600, operationSignal);
				this.install({ document, page, checkpoint: undefined });
				this.source = source; this.fileRevision = revision;
				this.edits = []; this.undone = []; this.savedEdits = [];
				this.hasExternalChange = false;
				this.reverted.fire();
				this.changed.fire();
			} catch (error) { document.dispose(); throw error; }
		});
	}

	public backup(): string {
		// Keep the original recovery data available if replay or checkpoint export failed.
		if (this.failedRecovery) return this.failedRecovery.content;
		const editCount = this.checkpoint?.editCount ?? 0;
		const edits = this.edits.slice(editCount);
		assert(edits.length <= maxBackupEdits, 'PDF backup requires a checkpoint before exceeding its edit limit');
		const saved = this.savedEdits;
		// A save before the checkpoint or on a different branch cannot be reached by replay from this source.
		const savedEdits = saved && saved.length >= editCount && saved.length - editCount <= maxBackupEdits
			&& structuralEquals(saved.slice(0, editCount), this.edits.slice(0, editCount)) ? saved.slice(editCount) : undefined;
		const source = this.checkpoint?.source ?? this.originalSource();
		const bytes = source.buffer instanceof ArrayBuffer ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : source.slice();
		return JSON.stringify({
			version: backupVersion,
			source: encodeBase64(VSBuffer.wrap(bytes)),
			edits,
			revision: this.fileRevision,
			savedEdits,
			copyOnly: this.savesCopy || undefined,
		});
	}

	private originalSource(): Uint8Array {
		assert(this.source, 'PDF edit history requires its original snapshot');
		return this.source;
	}

	public restoreBackup(content: string): Promise<void> {
		const backup = parseBackup(content);
		return this.serialize(async () => {
			if (this.isDirty) return;
			try {
				await this.applyBackup(backup);
			} catch (error) {
				this.failedRecovery = { content, error };
			}
			this.changed.fire();
		}).catch(() => undefined);
	}

	private async applyBackup({ source, edits, revision, savedEdits }: PdfBackup): Promise<void> {
		this.install(await this.rebuild(source, edits));
		this.source = source;
		this.fileRevision = revision;
		this.edits = edits;
		this.savedEdits = savedEdits;
		this.undone = [];
	}

	private async checkpointForNextEdit(): Promise<PdfCheckpoint | undefined> {
		if (this.edits.length - (this.checkpoint?.editCount ?? 0) < maxBackupEdits) return this.checkpoint;
		// Export before mutating the native document so an export failure leaves the last draft intact.
		const source = await this.document!.export(this.current!, this.lifetime.signal);
		return { source, editCount: this.edits.length };
	}

	private async rebuild(source: Uint8Array, edits: readonly PdfEdit[], checkpoint?: PdfCheckpoint): Promise<PdfRebuild> {
		// Undo can cross a checkpoint. In that case the original source still owns the full live history.
		let base = checkpoint && checkpoint.editCount <= edits.length ? checkpoint : undefined;
		const document = await this.pdf.open(base?.source ?? source, this.lifetime.signal);
		try {
			const checkpointAt = edits.length - maxBackupEdits;
			for (let index = base?.editCount ?? 0; index < edits.length; index++) {
				const edit = edits[index]!;
				const page = await document.page(edit.page, 1600, this.lifetime.signal, edit.edit);
				if (index + 1 === checkpointAt) {
					base = { source: await document.export(page, this.lifetime.signal), editCount: checkpointAt };
				}
			}
			const page = await document.page(this.current?.page ?? 1, 1600, this.lifetime.signal);
			return { document, page, checkpoint: base };
		} catch (error) { document.dispose(); throw error; }
	}

	private install({ document, page, checkpoint }: PdfRebuild): void {
		if (this.lifetime.signal.aborted) {
			document.dispose();
			this.lifetime.signal.throwIfAborted();
		}
		this.document?.dispose();
		this.document = document;
		this.current = page;
		this.checkpoint = checkpoint;
		this.failedRecovery = undefined;
	}

	private serialize<T>(run: () => Promise<T>): Promise<T> {
		const result = this.pending.then(() => { this.lifetime.signal.throwIfAborted(); return run(); });
		this.pending = result.catch(() => undefined);
		return result;
	}
}

function parseBackup(content: string): PdfBackup {
	const value: unknown = JSON.parse(content);
	if (!value || typeof value !== 'object' || !('source' in value) || typeof value.source !== 'string'
		|| value.source.length > Math.ceil(maxPdfBytes / 3) * 4 || !('edits' in value)
		|| ('copyOnly' in value && value.copyOnly !== true)
		|| ('version' in value && value.version !== backupVersion)) {
		throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.'));
	}
	const copyOnly = 'copyOnly' in value;
	const revision = 'revision' in value ? value.revision : undefined;
	if (typeof revision !== 'string' && (!copyOnly || revision !== undefined)) {
		throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.'));
	}
	// The old writer could emit more edits than its reader accepted. Replay and checkpoint those drafts once.
	const edits = parseBackupEdits(value.edits, 'version' in value ? maxBackupEdits : Infinity);
	const savedEdits = 'savedEdits' in value ? parseBackupEdits(value.savedEdits) : undefined;
	const source = decodeBase64(value.source).buffer;
	if (!source.length || source.length > maxPdfBytes) { throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.')); }
	return { source, edits, revision, savedEdits, copyOnly };
}

function parseBackupEdits(value: unknown, limit = maxBackupEdits): PdfEdit[] {
	if (!Array.isArray(value) || value.length > limit) {
		throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.'));
	}
	return value.map((entry: unknown) => {
		if (!entry || typeof entry !== 'object' || !('page' in entry) || typeof entry.page !== 'number'
			|| !Number.isSafeInteger(entry.page) || entry.page < 1 || !('edit' in entry)) {
			throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.'));
		}
		return { page: entry.page, edit: parseEdit(entry.edit) };
	});
}

function parseEdit(value: unknown): PdfAnnotationEdit {
	if (value && typeof value === 'object' && 'kind' in value) {
		if (value.kind === 'ink' && 'points' in value && Array.isArray(value.points)
			&& value.points.length >= 2 && value.points.length <= 1024
			&& value.points.every(point => point && typeof point === 'object'
				&& typeof point.x === 'number' && typeof point.y === 'number'
				&& Number.isFinite(point.x) && Number.isFinite(point.y)
				&& point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) {
			return { kind: 'ink', points: value.points.map(point => ({ x: point.x, y: point.y })) };
		}
		if (value.kind === 'delete' || value.kind === 'update') {
			if ('index' in value && typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0) {
				if (value.kind === 'delete') { return { kind: 'delete', index: value.index }; }
				if ('contents' in value && typeof value.contents === 'string' && value.contents.length <= 8192) { return { kind: 'update', index: value.index, contents: value.contents }; }
			}
		}
		if ((value.kind === 'highlight' || value.kind === 'note' || value.kind === 'text') && 'contents' in value && typeof value.contents === 'string'
			&& value.contents.length <= 8192 && 'bounds' in value && value.bounds && typeof value.bounds === 'object') {
			const bounds = value.bounds;
			if ('x' in bounds && typeof bounds.x === 'number' && 'y' in bounds && typeof bounds.y === 'number'
				&& 'width' in bounds && typeof bounds.width === 'number' && 'height' in bounds && typeof bounds.height === 'number'
				&& [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
				&& bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0
				&& bounds.x + bounds.width <= 1.001 && bounds.y + bounds.height <= 1.001) {
				return { kind: value.kind, contents: value.contents, bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } };
			}
		}
	}
	throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.'));
}
