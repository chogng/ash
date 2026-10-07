import { disposableWindowTimeout } from "../../../../base/browser/scheduler.js";
import { DisposableMap, Disposable, MutableDisposable, DisposableStore, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type IWorkingCopy, type IWorkingCopyService } from "../common/workingCopyService.js";
import { type IWorkingCopyBackupService } from "../common/workingCopyBackupService.js";

const BACKUP_DELAY_MS = 250;

/** Tracks dirty working copies and maintains their durable crash backups. */
export class WorkingCopyBackupTracker extends Disposable {
	private readonly registrations = this._register(new DisposableStore());
	private readonly tracked = this._register(new DisposableMap<IWorkingCopy, DisposableStore>());
	private readonly timers = new Map<IWorkingCopy, MutableDisposable<IDisposable>>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly edited = new Set<IWorkingCopy>();
	private stopped = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(private readonly workingCopies: IWorkingCopyService, private readonly backups: IWorkingCopyBackupService, private readonly ownerWindow: Window, private readonly onError: (error: unknown) => void = error => console.error("Failed to update working-copy backup", error)) {
		super();
		this.registrations.add(workingCopies.onDidRegister(copy => this.track(copy)));
		this.registrations.add(workingCopies.onDidUnregister(copy => this.untrack(copy)));
		for (const copy of workingCopies.getAll()) this.track(copy);
		this._register(toDisposable(() => {
			this.timers.clear();
			this.edited.clear();
		}));
	}

	flush(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		const pending = this.workingCopies.getAll().filter(copy => copy.isDirty || this.timers.get(copy)?.value);
		return Promise.all(pending.map(copy => this.persist(copy.resource, copy))).then(() => Promise.all(this.queues.values())).then(() => undefined);
	}

	/** Joins final content and cleanup before the window releases editors and backup storage. */
	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.assertNotDisposed();
		this.stopped = true;
		const inFlight = [...this.queues.values()];
		// Capture dirty content and clean pending deletes before cancelling their timers or editor owners.
		const pending = this.workingCopies.getAll().filter(copy => copy.isDirty || this.timers.get(copy)?.value);
		const finalWrites = pending.map(copy => this.persist(copy.resource, copy));
		this.registrations.clear();
		this.tracked.clearAndDisposeAll();
		this.timers.clear();
		this.edited.clear();
		this.shutdownPromise = Promise.allSettled([...inFlight, ...finalWrites]).then(results => {
			const failures = new Set(results.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
			// Failure must reach the shutdown join, after other resources have finished their final operations.
			if (failures.size > 0) throw new AggregateError(failures, 'Failed to drain working-copy backups');
		});
		return this.shutdownPromise;
	}

	private track(copy: IWorkingCopy): void {
		if (this.stopped || this.isDisposed) return;
		if (this.tracked.has(copy)) return;
		const listeners = new DisposableStore();
		this.timers.set(copy, listeners.add(new MutableDisposable<IDisposable>()));
		listeners.add(copy.onDidChangeContent(() => this.schedule(copy)));
		listeners.add(copy.onDidChangeDirty(() => { if (copy.isDirty) this.edited.add(copy); this.schedule(copy); }));
		this.tracked.set(copy, listeners);
		// A clean editor may be opening for crash restoration; its saved backup remains until restoration finishes.
		if (copy.isDirty) { this.edited.add(copy); this.schedule(copy); }
	}

	private untrack(copy: IWorkingCopy): void {
		if (this.stopped || this.isDisposed) return;
		this.cancel(copy);
		this.tracked.deleteAndDispose(copy);
		this.timers.delete(copy);
		// A failed recovery can unregister a clean copy. Its durable content still needs recovery.
		if (!this.edited.delete(copy)) return;
		const remaining = this.workingCopies.get(copy.resource);
		void this.persist(copy.resource, remaining.find(candidate => candidate.isDirty) ?? remaining[0]).catch(this.onError);
	}

	private schedule(copy: IWorkingCopy): void {
		if (this.stopped || this.isDisposed) return;
		this.cancel(copy);
		const timer = this.timers.get(copy);
		if (!timer) return;
		timer.value = disposableWindowTimeout(this.ownerWindow, () => {
			timer.clear();
			if (this.stopped || this.isDisposed) return;
			void this.persist(copy.resource, copy).catch(this.onError);
		}, BACKUP_DELAY_MS);
	}

	private cancel(copy: IWorkingCopy): void {
		this.timers.get(copy)?.clear();
	}

	private persist(resource: IWorkingCopy['resource'], copy?: IWorkingCopy): Promise<void> {
		if (copy) this.cancel(copy);
		const key = resource.toString();
		const dirtyCopy = copy?.isDirty ? copy : this.workingCopies.get(resource).find(candidate => candidate.isDirty);
		let operation: () => Promise<void>;
		try {
			if (dirtyCopy) {
				const backup = { resource: dirtyCopy.resource, kind: dirtyCopy.backupKind, content: dirtyCopy.backup(), updatedAt: Date.now(), ...(dirtyCopy.backupLanguageId ? { languageId: dirtyCopy.backupLanguageId } : {}), ...(dirtyCopy.backupContentType ? { contentType: dirtyCopy.backupContentType } : {}), ...(dirtyCopy.backupLabel ? { label: dirtyCopy.backupLabel } : {}) };
				operation = () => this.backups.store(backup);
			} else {
				operation = () => this.backups.delete(resource);
			}
		} catch (error) {
			return Promise.reject(error);
		}
		const queued = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
		this.queues.set(key, queued);
		return queued.finally(() => { if (this.queues.get(key) === queued) this.queues.delete(key); });
	}
}
