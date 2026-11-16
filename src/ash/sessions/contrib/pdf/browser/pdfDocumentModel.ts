import { assert } from '../../../../base/common/assert.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { structuralEquals } from '../../../../base/common/equals.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileRevisionConflictError, IFileService } from '../../../../platform/files/common/files.js';
import { IPdfService, type IPdfDocument, type PdfAnnotationEdit, type PdfPage } from '../../../../platform/pdf/common/pdfService.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../../workbench/common/editor.js';
import type { IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { localize } from '../../../../nls.js';

interface PdfEdit { readonly page: number; readonly edit: PdfAnnotationEdit; }
interface PdfCheckpoint { readonly source: Uint8Array; readonly editCount: number; }
interface PdfRebuild { readonly document: IPdfDocument; readonly page: PdfPage; readonly checkpoint: PdfCheckpoint | undefined; }

const backupVersion = 2;
const maxBackupEdits = 1000;
const maxPdfBytes = 64 * 1024 * 1024;

/** Owns the editor's draft, undo history and file revision; the native session is a derived snapshot. */
export class PdfDocumentModel extends Disposable implements IWorkingCopy {
	public readonly backupKind = 'structuredDocument';
	public readonly backupContentType = 'application/pdf';
	public readonly backupLabel = 'aspdf';
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeContent = this.changed.event;
	public readonly onDidChangeDirty = this.changed.event;
	public readonly onDidChangeExternalChange = this.changed.event;
	private readonly lifetime = new AbortController();
	private document: IPdfDocument | undefined;
	private source: Uint8Array = new Uint8Array();
	private fileRevision: string | undefined;
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
	public get readOnly(): boolean { return this.input.readOnly === true; }
	public get recoveryError(): unknown { return this.failedRecovery?.error; }

	public open(): Promise<void> {
		return this.serialize(async () => {
			if (this.input.initialBytes && this.readOnly) { this.source = this.input.initialBytes.slice(); }
			else {
				const stat = await this.files.stat(this.resource);
				if (stat.sizeBytes > maxPdfBytes) { throw new Error(localize('sessions.pdfPreview.tooLarge', 'PDFs larger than 64 MiB cannot be opened.')); }
				const file = await this.files.readFileBytes(this.resource);
				this.source = file.bytes;
				this.fileRevision = file.revision;
			}
			this.lifetime.signal.throwIfAborted();
			this.document = await this.pdf.open(this.source, this.lifetime.signal);
		});
	}

	public render(number: number, edit?: PdfAnnotationEdit): Promise<{ page: PdfPage; bytes: Uint8Array; }> {
		return this.serialize(async () => {
			if (edit && this.readOnly) { throw new Error(localize('sessions.pdfPreview.readOnly', 'This PDF is read-only.')); }
			if (edit && this.failedRecovery) { throw this.failedRecovery.error; }
			const checkpoint = edit ? await this.checkpointForNextEdit() : this.checkpoint;
			const document = this.document!;
			const page = await document.page(number, 1600, this.lifetime.signal, edit);
			this.current = page;
			if (edit) {
				this.checkpoint = checkpoint;
				this.edits.push({ page: number, edit });
				this.undone = [];
				this.changed.fire();
			}
			const bytes = await document.image(page, this.lifetime.signal);
			return { page, bytes };
		});
	}

	public undo(): Promise<void> {
		return this.serialize(async () => {
			const edit = this.edits.at(-1);
			if (!edit) { return; }
			if (this.failedRecovery) { throw this.failedRecovery.error; }
			this.install(await this.rebuild(this.source, this.edits.slice(0, -1), this.checkpoint));
			this.edits.pop(); this.undone.push(edit); this.changed.fire();
		});
	}

	public redo(): Promise<void> {
		return this.serialize(async () => {
			const edit = this.undone.at(-1);
			if (!edit) { return; }
			if (this.failedRecovery) { throw this.failedRecovery.error; }
			const checkpoint = await this.checkpointForNextEdit();
			this.install(await this.rebuild(this.source, [...this.edits, edit], checkpoint));
			this.undone.pop(); this.edits.push(edit); this.changed.fire();
		});
	}

	public save(signal: AbortSignal, _options?: ISaveOptions): Promise<void> {
		return this.serialize(async () => {
			if (this.readOnly || !this.current || !this.isDirty) { return; }
			// A failed replay leaves the previously opened native snapshot in place.
			if (this.failedRecovery) { throw this.failedRecovery.error; }
			const bytes = await this.document!.export(this.current, AbortSignal.any([signal, this.lifetime.signal]));
			try {
				const result = await this.files.writeFileBytes(this.resource, bytes, { create: false, overwrite: true, expectedRevision: this.fileRevision }, signal);
				this.fileRevision = result.revision;
				this.savedEdits = this.edits.slice();
				this.hasExternalChange = false; this.changed.fire();
			} catch (error) {
				if (error instanceof FileRevisionConflictError) { this.hasExternalChange = true; this.changed.fire(); }
				throw error;
			}
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
			const file = await this.files.readFileBytes(this.resource);
			const document = await this.pdf.open(file.bytes, AbortSignal.any([signal, this.lifetime.signal]));
			try {
				const page = await document.page(this.current?.page ?? 1, 1600, signal);
				this.install({ document, page, checkpoint: undefined });
				this.source = file.bytes; this.fileRevision = file.revision;
				this.edits = []; this.undone = []; this.savedEdits = [];
				this.hasExternalChange = false; this.changed.fire();
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
		return JSON.stringify({
			version: backupVersion,
			source: encodeBase64(VSBuffer.wrap((this.checkpoint?.source ?? this.source).slice())),
			edits,
			revision: this.fileRevision,
			savedEdits,
		});
	}

	public restoreBackup(content: string): void {
		const value: unknown = JSON.parse(content);
		if (!value || typeof value !== 'object' || !('source' in value) || typeof value.source !== 'string'
			|| value.source.length > Math.ceil(maxPdfBytes / 3) * 4
			|| !('edits' in value)
			|| !('revision' in value) || typeof value.revision !== 'string'
			|| ('version' in value && value.version !== backupVersion)) {
			throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.'));
		}
		// The old writer could emit more edits than its reader accepted. Replay and checkpoint those drafts once.
		const edits = parseBackupEdits(value.edits, 'version' in value ? maxBackupEdits : Infinity);
		const savedEdits = 'savedEdits' in value ? parseBackupEdits(value.savedEdits) : undefined;
		const source = decodeBase64(value.source).buffer;
		if (!source.length || source.length > maxPdfBytes) { throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.')); }
		const revision = value.revision;
		void this.serialize(async () => {
			try {
				this.install(await this.rebuild(source, edits));
				this.source = source;
				this.fileRevision = revision;
				this.edits = edits;
				this.savedEdits = savedEdits;
				this.undone = [];
			} catch (error) {
				this.failedRecovery = { content, error };
			}
			this.changed.fire();
		}).catch(() => undefined);
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
