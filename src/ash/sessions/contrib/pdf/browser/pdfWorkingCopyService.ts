import type { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IndexedDbWorkingCopyBackupService } from '../../../../workbench/services/workingCopy/browser/indexedDbWorkingCopyBackupService.js';
import { WorkingCopyBackupTracker } from '../../../../workbench/services/workingCopy/browser/workingCopyBackupTracker.js';
import type { IWorkingCopyBackupService } from '../../../../workbench/services/workingCopy/common/workingCopyBackupService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { PdfDocumentModel } from './pdfDocumentModel.js';

export const IPdfWorkingCopyService = createServiceIdentifier<IPdfWorkingCopyService>('pdfWorkingCopyService');
export interface IPdfWorkingCopyService {
	readonly backups: IWorkingCopyBackupService;
	acquire(input: IResourceEditorInput): { readonly model: PdfDocumentModel; readonly ready: Promise<void>; readonly release: IDisposable; };
	trackBackups(ownerWindow: Window, onError: (error: unknown) => void): WorkingCopyBackupTracker;
	discardBackup(resource: URI): Promise<void>;
}

interface Entry { readonly model: PdfDocumentModel; readonly ready: Promise<void>; readonly registration: IDisposable; references: number; }

/** One window owns one editable working copy per canonical resource, with pane-scoped leases. */
export class PdfWorkingCopyService extends Disposable implements IPdfWorkingCopyService {
	private readonly documents = new Map<string, Entry>();
	// Recovery needs the original PDF bytes, which can exceed the App Server backup record limit.
	public readonly backups = this._register(new IndexedDbWorkingCopyBackupService('sessions-pdf'));
	private tracker: WorkingCopyBackupTracker | undefined;

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IWorkingCopyService private readonly copies: IWorkingCopyService,
		@IUriIdentityService private readonly identity: IUriIdentityService,
	) {
		super();
		this._register(toDisposable(() => {
			for (const entry of this.documents.values()) { entry.registration.dispose(); entry.model.dispose(); }
			this.documents.clear();
		}));
	}

	public trackBackups(ownerWindow: Window, onError: (error: unknown) => void): WorkingCopyBackupTracker {
		const isPdf = (copy: IWorkingCopy) => copy instanceof PdfDocumentModel;
		const pdfEvent = (event: Event<IWorkingCopy>): Event<IWorkingCopy> => (listener, thisArgs, disposables) =>
			event(copy => { if (isPdf(copy)) listener.call(thisArgs, copy); }, undefined, disposables);
		return this.tracker ??= new WorkingCopyBackupTracker({
			getAll: () => this.copies.getAll().filter(isPdf),
			get: resource => this.copies.get(resource).filter(isPdf),
			onDidRegister: pdfEvent(this.copies.onDidRegister),
			onDidUnregister: pdfEvent(this.copies.onDidUnregister),
		}, this.backups, ownerWindow, onError);
	}

	public async discardBackup(resource: URI): Promise<void> {
		// Closing an editor can enqueue a final write of its dirty draft.
		await this.tracker?.flush();
		if (await this.backups.resolve(resource)) await this.backups.delete(resource);
	}

	public acquire(input: IResourceEditorInput): ReturnType<IPdfWorkingCopyService['acquire']> {
		// An immutable snapshot can name the same resource as a writable file.
		if (input.initialBytes) {
			const model = this.instantiation.createInstance(PdfDocumentModel, input);
			return { model, ready: model.open(), release: model };
		}
		const key = this.identity.asCanonicalUri(input.resource).toString();
		let entry = this.documents.get(key);
		if (!entry) {
			const model = this.instantiation.createInstance(PdfDocumentModel, input);
			const registration = new DisposableStore();
			registration.add(this.copies.register(model));
			const ready = model.open(async () => {
				const backup = await this.backups.resolve(model.resource);
				return backup?.kind === model.backupKind && backup.contentType === model.backupContentType ? backup.content : undefined;
			}).then(() => {
				// Saving these drafts needs a user-selected destination.
				if (model.savesCopy && !registration.isDisposed) registration.add(this.copies.registerAutoSave(model));
			});
			entry = { model, ready, registration, references: 0 };
			this.documents.set(key, entry);
		}
		const owned = entry;
		owned.references++;
		return {
			model: owned.model, ready: owned.ready, release: toDisposable(() => {
				if (--owned.references === 0 && this.documents.get(key) === owned) {
					this.documents.delete(key); owned.registration.dispose(); owned.model.dispose();
				}
			})
		};
	}
}
