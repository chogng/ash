import {
	Disposable,
	MutableDisposable,
	toDisposable,
	type IDisposable,
} from '../../../src/ash/base/common/lifecycle.js';
import { Emitter } from '../../../src/ash/base/common/event.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IFileDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import {
	IWorkingCopyService,
	type IWorkingCopy,
} from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import type { IResourceEditorInput } from '../../../src/ash/workbench/common/editor.js';
import { localize } from '../../../src/ash/nls.js';
import {
	emptyLibrary,
	importRecords,
	LIBRARY_CONTENT_TYPE,
	parseLibrary,
	serializeLibrary,
	type ReferenceLibrary,
} from '../common/library.js';
import { parseRis } from '../common/ris.js';

/** One window-local authoritative working copy per resource; disk revisions coordinate other windows. */
export class ReferenceLibraryWorkingCopy extends Disposable implements IWorkingCopy {
	readonly format = 'ash.reference-library.v1';
	readonly backupKind = 'text' as const;
	readonly backupContentType = LIBRARY_CONTENT_TYPE;
	private readonly externalChanged = this._register(new Emitter<void>());
	readonly onDidChangeExternalChange = this.externalChanged.event;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeContent = this.changed.event;
	readonly onDidChangeDirty = this.changed.event;
	readonly ready: Promise<void>;
	library: ReferenceLibrary = emptyLibrary();
	resource: URI;
	private baseline = '';
	private revision: string | undefined;
	private references = 0;
	private writableReferences = 0;
	private target: URI | undefined;
	private readonly lifetime = new AbortController();
	private readonly registration = this._register(new MutableDisposable<IDisposable>());
	private saving: Promise<void> | undefined;
	private transferred = false;
	private loading = true;
	private external = false;
	get hasExternalChange(): boolean {
		return this.external;
	}
	private setExternal(value: boolean): void {
		if (value !== this.external) {
			this.external = value;
			this.externalChanged.fire();
		}
	}

	constructor(
		input: IResourceEditorInput,
		readonly providerSignal: AbortSignal,
		@IFileService private readonly files: IFileService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IWorkingCopyService private readonly copies: IWorkingCopyService,
	) {
		super();
		this.resource = input.resource;
		this.registration.value = copies.register(this);
		this.ready = this.load(input).then(() => {
			this.loading = false;
			this.changed.fire();
		});
	}
	get readOnly(): boolean {
		return this.writableReferences === 0 || this.providerSignal.aborted || this.transferred;
	}
	get isDirty(): boolean {
		return !this.loading && !this.transferred && this.backup() !== this.baseline;
	}
	get persisted(): boolean {
		return this.target !== undefined;
	}
	retain(readOnly = false): IDisposable {
		this.references++;
		if (!readOnly) this.writableReferences++;
		return toDisposable(() => {
			if (!readOnly) this.writableReferences--;
			if (--this.references === 0) this.dispose();
		});
	}
	private async load(input: IResourceEditorInput, signal?: AbortSignal): Promise<void> {
		if (input.resource.scheme === 'untitled') {
			this.changed.fire();
			return;
		}
		const content =
			input.initialText === undefined
				? await this.files.readFile(input.resource)
				: { content: input.initialText, revision: undefined };
		this.lifetime.signal.throwIfAborted();
		this.providerSignal.throwIfAborted();
		signal?.throwIfAborted();
		if (/\.ris$/iu.test(input.resource.path)) {
			this.library = importRecords(emptyLibrary(), parseRis(content.content)).library;
			this.baseline = '';
		} else {
			this.library = content.content.trim()
				? parseLibrary(content.content.replace(/^\uFEFF/u, ''))
				: emptyLibrary();
			this.target = input.resource;
			this.revision = content.revision;
			this.baseline = this.backup();
		}
		this.changed.fire();
	}
	replace(library: ReferenceLibrary): void {
		this.assertWritable();
		this.library = parseLibrary(serializeLibrary(library));
		this.changed.fire();
	}
	backup(): string {
		return serializeLibrary(this.library);
	}
	restoreBackup(content: string): void {
		this.assertWritable();
		this.library = parseLibrary(content);
		this.changed.fire();
	}
	/** A newly admitted provider may take over a frozen draft; the old view ceases to own dirty/recovery state. */
	peekRecovery(): { content: string; revision: string | undefined; target: URI | undefined } | undefined {
		if (!this.providerSignal.aborted || this.transferred || !this.isDirty) return undefined;
		const recovery = { content: this.backup(), revision: this.revision, target: this.target };
		return recovery;
	}
	acknowledgeRecovery(): void {
		this.transferred = true;
		this.changed.fire();
	}
	acceptRecovery(recovery: { content: string; revision: string | undefined; target: URI | undefined }): void {
		this.library = parseLibrary(recovery.content);
		this.revision = recovery.revision;
		this.target = recovery.target;
		this.baseline = '';
		this.changed.fire();
	}
	async save(signal: AbortSignal): Promise<void> {
		await this.ready;
		this.assertWritable();
		if (this.saving) {
			await this.saving;
			if (this.isDirty) await this.save(signal);
			return;
		}
		if (!this.target) {
			const destination = await this.dialogs.showSaveDialog({
				title: localize('references.saveLibrary', 'Save reference library'),
				filters: [
					{ name: localize('references.libraryFiles', 'Reference libraries'), extensions: ['ash-library'] },
				],
			});
			if (destination) await this.saveAs(destination, signal);
			return;
		}
		if (!this.isDirty) return;
		const content = this.backup();
		const target = this.target;
		const lifetime = AbortSignal.any([signal, this.providerSignal, this.lifetime.signal]);
		lifetime.throwIfAborted();
		this.saving = (async () => {
			try {
				const result = await this.files.writeFile(
					{
						resource: target,
						content,
						...(this.revision === undefined ? {} : { expectedRevision: this.revision }),
					},
					{ create: true, overwrite: this.revision !== undefined },
					lifetime,
				);
				lifetime.throwIfAborted();
				this.revision = result.revision;
				this.baseline = content;
				this.setExternal(false);
			} catch (error) {
				if (!lifetime.aborted) this.setExternal(true);
				throw error;
			} finally {
				this.saving = undefined;
				this.changed.fire();
			}
		})();
		await this.saving;
	}
	async saveAs(resource: URI, signal: AbortSignal): Promise<void> {
		await this.ready;
		this.assertWritable();
		if (!/\.ash-library$/iu.test(resource.path))
			throw new Error(localize('references.extension', 'Choose a file ending in .ash-library.'));
		while (this.saving) await this.saving;
		this.assertWritable();
		const content = this.backup();
		const lifetime = AbortSignal.any([signal, this.providerSignal, this.lifetime.signal]);
		lifetime.throwIfAborted();
		this.saving = (async () => {
			try {
				const result = await this.files.writeFile(
					{ resource, content },
					{ create: true, overwrite: false },
					lifetime,
				);
				lifetime.throwIfAborted();
				this.baseline = content;
				this.changed.fire();
				this.registration.clear();
				this.target = resource;
				this.resource = resource;
				this.revision = result.revision;
				this.setExternal(false);
				this.registration.value = this.copies.register(this);
			} finally {
				this.saving = undefined;
				this.changed.fire();
			}
		})();
		await this.saving;
	}
	async revert(signal: AbortSignal): Promise<void> {
		await this.ready;
		// Reload is an explicit discard, including after a failed write. It must
		// observe the destination selected by every preceding Save As operation.
		while (this.saving) await this.saving.catch(() => {});
		this.assertWritable();
		signal.throwIfAborted();
		this.saving = (async () => {
			try {
				await this.load({ resource: this.target ?? this.resource }, signal);
				this.setExternal(false);
			} finally {
				this.saving = undefined;
				this.changed.fire();
			}
		})();
		await this.saving;
	}
	private assertWritable(): void {
		if (this.isDisposed || this.readOnly)
			throw new Error(
				localize('references.readOnly', 'This library is read-only or its extension is unavailable.'),
			);
	}
	override dispose(): void {
		this.lifetime.abort();
		super.dispose();
	}
}

/** Structural ownership survives independently evaluated client generations; no module-level service cache is used. */
export function isReferenceLibraryCopy(copy: IWorkingCopy): copy is ReferenceLibraryWorkingCopy {
	return 'format' in copy && copy.format === 'ash.reference-library.v1';
}
