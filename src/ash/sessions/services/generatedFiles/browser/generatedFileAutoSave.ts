import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { SaveReason } from '../../../../workbench/common/editor.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { IGeneratedFilesService } from '../common/generatedFilesService.js';

/** Generated files save through their existing working copy, including revision checks and undo history. */
export class GeneratedFileAutoSave extends Disposable {
	private readonly copies = this._register(new DisposableMap<IWorkingCopy, DisposableStore & { readonly schedule: RunOnceScheduler; }>());
	private readonly saves = new Map<IWorkingCopy, Promise<void>>();

	constructor(
		@IGeneratedFilesService private readonly generatedFiles: IGeneratedFilesService,
		@IWorkingCopyService workingCopies: IWorkingCopyService,
		@ILifecycleService lifecycle: ILifecycleService,
		@ILogService private readonly log: ILogService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(workingCopies.onDidRegister(copy => this.track(copy)));
		this._register(workingCopies.onDidUnregister(copy => this.copies.deleteAndDispose(copy)));
		this._register(generatedFiles.onDidChange(() => { for (const copy of workingCopies.getAll()) this.track(copy); }));
		for (const copy of workingCopies.getAll()) this.track(copy);
		this._register(lifecycle.onWillShutdown(event => {
			event.join(async () => {
				// Unregistration can retire tracking while an already-started write still owns IO.
				await Promise.all([...this.saves.values(), ...[...this.copies.keys()].map(copy => this.save(copy))]);
			}, 'Save generated files', () => [...this.copies.keys()].every(copy => !copy.isDirty) && this.saves.size === 0);
		}));
	}

	private track(copy: IWorkingCopy): void {
		if (!this.generatedFiles.isGeneratedResource(copy.resource)) {
			this.copies.deleteAndDispose(copy);
			return;
		}
		if (this.copies.has(copy)) return;
		const store = new DisposableStore();
		const schedule = store.add(new RunOnceScheduler(() => {
			void this.save(copy).catch(error => {
				this.log.error('Generated file auto-save failed', error);
				this.notifications.error(localize({ bundle: 'ash.artifacts', key: 'generatedFileSaveFailed' }, 'Could not save changes to {0}. Your edits remain open. Resolve the save error before closing the file.', copy.backupLabel ?? copy.resource.path.split('/').at(-1) ?? ''));
			});
		}, 300));
		const scheduleSave = (): void => {
			// The in-flight save observes subsequent edits itself. Queuing a timer here
			// could retry a failed save without another user edit.
			if (copy.isDirty && !this.saves.has(copy)) schedule.schedule();
			else schedule.cancel();
		};
		store.add(copy.onDidChangeContent(scheduleSave));
		store.add(copy.onDidChangeDirty(scheduleSave));
		this.copies.set(copy, Object.assign(store, { schedule }));
		if (copy.isDirty) schedule.schedule();
	}

	private save(copy: IWorkingCopy): Promise<void> {
		const pending = this.saves.get(copy);
		if (pending) return pending;
		const tracked = this.copies.get(copy);
		if (!tracked) return Promise.resolve();
		tracked.schedule.cancel();
		// Publish the whole operation before calling save: participants may emit
		// content or dirty events synchronously, and shutdown must join every write.
		const saving = Promise.resolve().then(async () => {
			if (this.copies.get(copy) !== tracked || !copy.isDirty) return;
			let changed = false;
			using content = copy.onDidChangeContent(() => { changed = true; });
			using dirty = copy.onDidChangeDirty(() => { if (copy.isDirty) changed = true; });
			while (this.copies.get(copy) === tracked && copy.isDirty) {
				if (!this.generatedFiles.isGeneratedResource(copy.resource)) {
					this.copies.deleteAndDispose(copy);
					return;
				}
				if (copy.hasExternalChange) throw new Error('Generated file has an unresolved external change');
				changed = false;
				await copy.save(new AbortController().signal, { reason: SaveReason.AUTO });
				// Dirty alone does not prove a newer snapshot exists. A no-op save must
				// fail rather than spin forever, including in a shutdown final callback.
				if (this.copies.get(copy) === tracked && copy.isDirty && !changed) throw new Error('Generated file save did not clear dirty state');
			}
		}).finally(() => this.saves.delete(copy));
		this.saves.set(copy, saving);
		return saving;
	}
}
