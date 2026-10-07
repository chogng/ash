import { disposableWindowTimeout } from "../../../../base/browser/scheduler.js";
import { DisposableMap, Disposable, MutableDisposable, DisposableStore, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
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
	private readonly pendingResources = new Map<string, URI>();
	private generation = 0;
	private paused = false;
	private stopped = false;
	private shutdownSettled = false;
	private shutdownFailed = false;
	private drainedGeneration = -1;
	private shutdownPromise: Promise<void> | undefined;

	constructor(private readonly workingCopies: IWorkingCopyService, private readonly backups: IWorkingCopyBackupService, private readonly ownerWindow: Window, private readonly onError: (error: unknown) => void = error => console.error("Failed to update working-copy backup", error)) {
		super();
		this.registrations.add(workingCopies.onDidRegister(copy => this.track(copy)));
		this.registrations.add(workingCopies.onDidUnregister(copy => this.untrack(copy)));
		for (const copy of workingCopies.getAll()) this.track(copy);
		this._register(toDisposable(() => {
			this.timers.clear();
			this.edited.clear();
			this.pendingResources.clear();
		}));
	}

	flush(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		const copies = this.workingCopies.getAll().filter(copy => copy.isDirty || this.timers.get(copy)?.value);
		const captured = new Set(copies.map(copy => copy.resource.toString()));
		const remaining = [...this.pendingResources.values()].filter(resource => !captured.has(resource.toString()));
		return Promise.all([...copies.map(copy => this.persist(copy.resource, copy)), ...remaining.map(resource => this.persist(resource))]).then(() => Promise.all(this.queues.values())).then(() => undefined);
	}

	/** Whether final content still matches the current registry and working-copy generation. */
	get isShutdownCurrent(): boolean { return this.paused && this.shutdownSettled && !this.shutdownFailed && this.drainedGeneration === this.generation; }

	/** Pauses timers, retaining change listeners until the lifecycle reports its overall result. */
	shutdown(): Promise<void> {
		if (this.shutdownPromise && (!this.shutdownSettled || this.shutdownFailed || this.isShutdownCurrent)) return this.shutdownPromise;
		this.assertNotDisposed();
		this.paused = true;
		this.shutdownSettled = false;
		this.shutdownFailed = false;
		for (const copy of this.workingCopies.getAll()) {
			if (copy.isDirty || this.timers.get(copy)?.value) this.pendingResources.set(copy.resource.toString(), copy.resource);
			this.cancel(copy);
		}
		// Publish before capture: backup serialization can reenter content or registry listeners.
		this.shutdownPromise = Promise.resolve().then(() => this.drain()).catch(error => { this.shutdownFailed = true; throw error; }).finally(() => { this.shutdownSettled = true; });
		return this.shutdownPromise;
	}

	/** Resumes a cancelled attempt only after every lifecycle join has settled. */
	cancelShutdown(): void {
		if (!this.paused || this.stopped || this.isDisposed) return;
		if (!this.shutdownSettled) throw new Error('Backup shutdown must settle before cancellation');
		this.paused = false;
		this.shutdownPromise = undefined;
		for (const copy of this.workingCopies.getAll()) {
			this.track(copy);
			if (copy.isDirty) this.schedule(copy);
		}
		// Include changes, failed cleanup and registrations that arrived during the paused attempt.
		void this.flush().catch(this.onError);
	}

	/** Stops producers after committed shutdown or forced pagehide teardown, before editor and database disposal. */
	completeShutdown(): void {
		if (this.stopped || this.isDisposed) return;
		this.stopped = true;
		this.registrations.clear();
		this.tracked.clearAndDisposeAll();
		this.timers.clear();
		this.edited.clear();
		this.pendingResources.clear();
	}

	private async drain(): Promise<void> {
		let inFlight = [...this.queues.values()];
		const failures = new Set<unknown>();
		let capturedGeneration: number;
		do {
			capturedGeneration = this.generation;
			const pending = [...this.pendingResources.values()];
			this.pendingResources.clear();
			const writes = pending.flatMap(resource => {
				const dirty = this.workingCopies.get(resource).filter(copy => copy.isDirty);
				return dirty.length > 0 ? dirty.map(copy => this.persist(resource, copy)) : [this.persist(resource)];
			});
			const results = await Promise.allSettled([...inFlight, ...writes]);
			for (const result of results) {
				if (result.status === 'rejected') failures.add(result.reason);
			}
			inFlight = [];
			// Content, dirty state and registry changes invalidate both capture and async writes.
		} while (capturedGeneration !== this.generation);
		if (failures.size > 0) throw new AggregateError(failures, 'Failed to drain working-copy backups');
		this.drainedGeneration = capturedGeneration;
	}

	private track(copy: IWorkingCopy): void {
		if (this.stopped || this.isDisposed) return;
		if (this.tracked.has(copy)) return;
		this.generation++;
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
		this.generation++;
		// A failed recovery can unregister a clean copy. Its durable content still needs recovery.
		if (!this.edited.delete(copy)) return;
		if (this.paused) { this.pendingResources.set(copy.resource.toString(), copy.resource); return; }
		const remaining = this.workingCopies.get(copy.resource);
		void this.persist(copy.resource, remaining.find(candidate => candidate.isDirty) ?? remaining[0]).catch(this.onError);
	}

	private schedule(copy: IWorkingCopy): void {
		if (this.stopped || this.isDisposed) return;
		this.generation++;
		this.pendingResources.set(copy.resource.toString(), copy.resource);
		this.cancel(copy);
		if (this.paused) return;
		const timer = this.timers.get(copy);
		if (!timer) return;
		timer.value = disposableWindowTimeout(this.ownerWindow, () => {
			timer.clear();
			if (this.paused || this.stopped || this.isDisposed) return;
			void this.persist(copy.resource, copy).catch(this.onError);
		}, BACKUP_DELAY_MS);
	}

	private cancel(copy: IWorkingCopy): void {
		this.timers.get(copy)?.clear();
	}

	private persist(resource: IWorkingCopy['resource'], copy?: IWorkingCopy): Promise<void> {
		for (const candidate of this.workingCopies.get(resource)) this.cancel(candidate);
		const key = resource.toString();
		this.pendingResources.delete(key);
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
			this.pendingResources.set(key, resource);
			return Promise.reject(error);
		}
		const queued = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
		this.queues.set(key, queued);
		return queued.catch(error => { this.pendingResources.set(key, resource); throw error; }).finally(() => { if (this.queues.get(key) === queued) this.queues.delete(key); });
	}
}
