import { Action } from '../../../../base/common/actions.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { SaveReason } from '../../../../workbench/common/editor.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { IGeneratedFilesService } from '../../generatedFiles/common/generatedFilesService.js';
import { IArtifactAutoSaveService } from '../common/artifactAutoSaveService.js';
import type { URI } from '../../../../base/common/uri.js';

/** Chat artifacts save through their existing working copy; the editor retains content and history. */
export class ArtifactAutoSaveService extends Disposable implements IArtifactAutoSaveService {
	private readonly managed = new Map<IWorkingCopy, number>();
	private readonly copies = this._register(new DisposableMap<IWorkingCopy, DisposableStore & { readonly schedule: RunOnceScheduler; }>());
	private readonly saves = new Map<IWorkingCopy, Promise<void>>();

	constructor(
		@IGeneratedFilesService private readonly generatedFiles: IGeneratedFilesService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@ILifecycleService lifecycle: ILifecycleService,
		@ILogService private readonly log: ILogService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(workingCopies.onDidRegister(copy => this.track(copy)));
		this._register(workingCopies.onDidUnregister(copy => { this.copies.deleteAndDispose(copy); }));
		this._register(generatedFiles.onDidChange(() => { for (const copy of workingCopies.getAll()) this.track(copy); }));
		for (const copy of workingCopies.getAll()) this.track(copy);
		this._register(lifecycle.onWillShutdown(event => {
			event.join(async () => {
				// Unregistration can retire tracking while an already-started write still owns IO.
				await Promise.all([...this.saves.values(), ...[...this.copies.keys()].map(copy => this.save(copy))]);
			}, 'Save artifacts', () => [...this.copies.keys()].every(copy => !copy.isDirty) && this.saves.size === 0);
		}));
	}

	public register(copy: IWorkingCopy): IDisposable {
		this.managed.set(copy, (this.managed.get(copy) ?? 0) + 1);
		this.track(copy);
		return toDisposable(() => {
			const count = this.managed.get(copy)! - 1;
			if (count) this.managed.set(copy, count);
			else { this.managed.delete(copy); this.track(copy); }
		});
	}

	public async flush(resource: URI): Promise<void> {
		await Promise.all(this.workingCopies.get(resource).filter(copy => this.copies.has(copy)).map(async copy => {
			try { await this.save(copy); }
			catch (error) { this.reportSaveError(copy, error); throw error; }
		}));
	}

	private owns(copy: IWorkingCopy): boolean {
		return this.managed.has(copy) || this.generatedFiles.isGeneratedResource(copy.resource);
	}

	private track(copy: IWorkingCopy): void {
		if (!this.workingCopies.getAll().includes(copy) || !this.owns(copy)) {
			this.copies.deleteAndDispose(copy);
			return;
		}
		if (this.copies.has(copy)) return;
		const store = new DisposableStore();
		store.add(this.workingCopies.registerAutoSave(copy));
		const schedule = store.add(new RunOnceScheduler(() => {
			void this.save(copy).catch(error => this.reportSaveError(copy, error));
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

	private reportSaveError(copy: IWorkingCopy, error: unknown): void {
		const tracked = this.copies.get(copy);
		if (!tracked) return;
		this.log.error('Artifact auto-save failed', error);
		const retry = tracked.add(Object.assign(new Action('artifacts.retrySave', localize('sessions.design.retrySave', 'Retry saving'), '', true, async () => {
			try { await this.save(copy); notification.close(); }
			catch (error) { this.log.error('Artifact auto-save retry failed', error); }
		}), { keepOpen: true }));
		const notification = this.notifications.notify({
			severity: Severity.Error,
			message: localize({ bundle: 'ash.artifacts', key: 'generatedFileSaveFailed' }, 'Could not save changes to {0}. Your edits remain open. Resolve the save error before closing the file.', copy.backupLabel ?? copy.resource.path.split('/').at(-1) ?? ''),
			actions: { primary: [retry] },
		});
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
				if (!this.owns(copy)) {
					this.copies.deleteAndDispose(copy);
					return;
				}
				if (copy.hasExternalChange) throw new Error('Artifact has an unresolved external change');
				changed = false;
				await copy.save(new AbortController().signal, { reason: SaveReason.AUTO });
				// Dirty alone does not prove a newer snapshot exists. A no-op save must
				// fail rather than spin forever, including in a shutdown final callback.
				if (this.copies.get(copy) === tracked && copy.isDirty && !changed) throw new Error('Artifact save did not clear dirty state');
			}
		}).finally(() => this.saves.delete(copy));
		this.saves.set(copy, saving);
		return saving;
	}
}
