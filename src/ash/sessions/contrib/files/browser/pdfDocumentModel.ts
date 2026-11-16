import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { FileRevisionConflictError, IFileService } from '../../../../platform/files/common/files.js';
import { IPdfService, type IPdfDocument, type PdfAnnotationEdit, type PdfPage } from '../../../../platform/pdf/common/pdfService.js';
import type { IResourceEditorInput, ISaveOptions } from '../../../../workbench/common/editor.js';
import type { IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { localize } from '../../../../nls.js';

interface PdfEdit { readonly page: number; readonly edit: PdfAnnotationEdit; }

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
	private saved = '[]';
	private pending: Promise<unknown> = Promise.resolve();
	public current: PdfPage | undefined;
	public hasExternalChange = false;
	public recoveryError: unknown;

	constructor(
		private readonly input: IResourceEditorInput,
		@IFileService private readonly files: IFileService,
		@IPdfService private readonly pdf: IPdfService,
	) {
		super();
		this._register(toDisposable(() => { this.lifetime.abort(); this.document?.dispose(); }));
	}

	public get resource(): URI { return this.input.resource; }
	public get isDirty(): boolean { return JSON.stringify(this.edits) !== this.saved; }
	public get canUndo(): boolean { return this.edits.length > 0; }
	public get canRedo(): boolean { return this.undone.length > 0; }
	public get readOnly(): boolean { return this.input.readOnly === true; }

	public async open(): Promise<void> {
		if (this.input.initialBytes && this.readOnly) { this.source = this.input.initialBytes.slice(); }
		else {
			const stat = await this.files.stat(this.resource);
			if (stat.sizeBytes > 64 * 1024 * 1024) { throw new Error(localize('sessions.pdfPreview.tooLarge', 'PDFs larger than 64 MiB cannot be opened.')); }
			const file = await this.files.readFileBytes(this.resource);
			this.source = file.bytes;
			this.fileRevision = file.revision;
		}
		this.lifetime.signal.throwIfAborted();
		this.document = await this.pdf.open(this.source, this.lifetime.signal);
	}

	public render(number: number, edit?: PdfAnnotationEdit): Promise<{ page: PdfPage; bytes: Uint8Array; }> {
		return this.serialize(async () => {
			if (edit && this.readOnly) { throw new Error(localize('sessions.pdfPreview.readOnly', 'This PDF is read-only.')); }
			const page = await this.document!.page(number, 1600, this.lifetime.signal, edit);
			if (edit) { this.edits.push({ page: number, edit }); this.undone = []; }
			this.current = page;
			const bytes = await this.document!.image(page, this.lifetime.signal);
			if (edit) { this.changed.fire(); }
			return { page, bytes };
		});
	}

	public undo(): Promise<void> {
		return this.serialize(async () => {
			const edit = this.edits.at(-1);
			if (!edit) { return; }
			await this.rebuild(this.edits.slice(0, -1));
			this.edits.pop(); this.undone.push(edit); this.changed.fire();
		});
	}

	public redo(): Promise<void> {
		return this.serialize(async () => {
			const edit = this.undone.at(-1);
			if (!edit) { return; }
			await this.rebuild([...this.edits, edit]);
			this.undone.pop(); this.edits.push(edit); this.changed.fire();
		});
	}

	public save(signal: AbortSignal, _options?: ISaveOptions): Promise<void> {
		return this.serialize(async () => {
			if (this.readOnly || !this.current || !this.isDirty) { return; }
			const bytes = await this.document!.export(this.current, AbortSignal.any([signal, this.lifetime.signal]));
			try {
				const result = await this.files.writeFileBytes(this.resource, bytes, { create: false, overwrite: true, expectedRevision: this.fileRevision }, signal);
				this.fileRevision = result.revision; this.saved = JSON.stringify(this.edits);
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
				this.document?.dispose(); this.document = document; this.current = page;
				this.source = file.bytes; this.fileRevision = file.revision;
				this.edits = []; this.undone = []; this.saved = '[]';
				this.hasExternalChange = false; this.changed.fire();
			} catch (error) { document.dispose(); throw error; }
		});
	}

	public backup(): string {
		return JSON.stringify({ source: encodeBase64(VSBuffer.wrap(this.source.slice())), edits: this.edits, revision: this.fileRevision });
	}

	public restoreBackup(content: string): void {
		const value: unknown = JSON.parse(content);
		if (!value || typeof value !== 'object' || !('source' in value) || typeof value.source !== 'string'
			|| !('edits' in value) || !Array.isArray(value.edits) || value.edits.length > 1000
			|| !('revision' in value) || typeof value.revision !== 'string') {
			throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.'));
		}
		// Recovery is a persistence boundary: validate the full operation log before replay.
		const edits: PdfEdit[] = value.edits.map((entry: unknown) => {
			if (!entry || typeof entry !== 'object' || !('page' in entry) || !Number.isSafeInteger(entry.page)
				|| typeof entry.page !== 'number' || entry.page < 1 || !('edit' in entry)) {
				throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.'));
			}
			return { page: entry.page, edit: parseEdit(entry.edit) };
		});
		const source = decodeBase64(value.source).buffer;
		if (!source.length || source.length > 64 * 1024 * 1024) { throw new Error(localize('sessions.pdfPreview.invalidBackup', 'Invalid aspdf recovery data.')); }
		this.source = source; this.fileRevision = value.revision;
		this.edits = edits;
		void this.serialize(async () => { await this.rebuild(edits); this.changed.fire(); }).catch(error => {
			this.recoveryError = error; this.changed.fire();
		});
	}

	private async rebuild(edits: readonly PdfEdit[]): Promise<void> {
		const document = await this.pdf.open(this.source, this.lifetime.signal);
		try {
			for (const edit of edits) { await document.page(edit.page, 1600, this.lifetime.signal, edit.edit); }
			const page = await document.page(this.current?.page ?? 1, 1600, this.lifetime.signal);
			this.document?.dispose(); this.document = document; this.current = page;
		} catch (error) { document.dispose(); throw error; }
	}

	private serialize<T>(run: () => Promise<T>): Promise<T> {
		const result = this.pending.then(() => { this.lifetime.signal.throwIfAborted(); return run(); });
		this.pending = result.catch(() => undefined);
		return result;
	}
}

function parseEdit(value: unknown): PdfAnnotationEdit {
	if (value && typeof value === 'object' && 'kind' in value) {
		if (value.kind === 'delete' || value.kind === 'update') {
			if ('index' in value && typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0) {
				if (value.kind === 'delete') { return { kind: 'delete', index: value.index }; }
				if ('contents' in value && typeof value.contents === 'string' && value.contents.length <= 8192) { return { kind: 'update', index: value.index, contents: value.contents }; }
			}
		}
		if ((value.kind === 'highlight' || value.kind === 'note') && 'contents' in value && typeof value.contents === 'string'
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
