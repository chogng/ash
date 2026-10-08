import { disposableWindowTimeout } from "../../../../base/browser/scheduler.js";
import { DisposableMap, Disposable, MutableDisposable, DisposableStore, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { type IWorkingCopy, type IWorkingCopyService } from "../common/workingCopyService.js";
import { type IWorkingCopyBackupService } from "../common/workingCopyBackupService.js";
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import type { TextModelSaveCompletion, TextModelSaveRecoveryContext } from '../../textmodelResolver/common/textModelResourceService.js';
import type { WorkingCopyBackup } from '../common/workingCopyBackupService.js';

const BACKUP_DELAY_MS = 250;

/** Tracks dirty working copies and maintains their durable crash backups. */
export class WorkingCopyBackupTracker extends Disposable {
	private readonly registrations = this._register(new DisposableStore());
	private readonly tracked = this._register(new DisposableMap<IWorkingCopy, DisposableStore>());
	private readonly timers = new Map<IWorkingCopy, MutableDisposable<IDisposable>>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly edited = new Set<IWorkingCopy>();
	private readonly pendingResources = new Map<string, URI>();
	private readonly resourceGenerations = new Map<string, number>();
	private generation = 0;
	private paused = false;
	private stopped = false;
	private shutdownSettled = false;
	private shutdownFailed = false;
	private drainedGeneration = -1;
	private shutdownPromise: Promise<void> | undefined;

	constructor(private readonly workingCopies: IWorkingCopyService, private readonly backups: IWorkingCopyBackupService, private readonly ownerWindow: Window, private readonly onError: (error: unknown) => void = error => console.error("Failed to update working-copy backup", error), private readonly retainRecovery?: (resource: URI) => boolean) {
		super();
		this.registrations.add(workingCopies.onDidRegister(copy => this.track(copy)));
		this.registrations.add(workingCopies.onDidUnregister(copy => this.untrack(copy)));
		for (const copy of workingCopies.getAll()) this.track(copy);
		this._register(toDisposable(() => {
			this.timers.clear();
			this.edited.clear();
			this.pendingResources.clear();
			this.resourceGenerations.clear();
		}));
	}

	flush(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		const copies = this.workingCopies.getAll().filter(copy => copy.isDirty || this.timers.get(copy)?.value);
		const captured = new Set(copies.map(copy => copy.resource.toString()));
		const remaining = [...this.pendingResources.values()].filter(resource => !captured.has(resource.toString()));
		return Promise.all([...copies.map(copy => this.persist(copy.resource, copy)), ...remaining.map(resource => this.persist(resource))]).then(() => Promise.all(this.queues.values())).then(() => undefined);
	}

	/** A failed post-save discard must leave current recovery content, never an older draft. */
	public async prepareSave(model: TextModel, signal: AbortSignal, recovery?: TextModelSaveRecoveryContext): Promise<TextModelSaveCompletion | undefined> {
		throwIfCancelled(signal);
		if (this.paused || this.stopped || this.isDisposed) throw new CancellationError();
		const copy = this.workingCopies.get(model.uri).find(candidate => candidate.backupKind === 'text' && (candidate.isDirty || this.edited.has(candidate) || recovery?.retry));
		if (!copy) return undefined;
		const metadata = { contentType: copy.backupContentType, label: copy.backupLabel };
		const key = model.uri.toString();
		let generation: number;
		let content: string;
		do {
			generation = this.resourceGenerations.get(key) ?? 0;
			content = model.getText();
			await this.persist(model.uri, undefined, () => textBackup(model, metadata));
			if (generation === (this.resourceGenerations.get(key) ?? 0) && content === model.getText()) recovery?.acknowledge(model.version);
			throwIfCancelled(signal);
			if (this.paused || this.stopped || this.isDisposed) throw new CancellationError();
		} while (generation !== (this.resourceGenerations.get(key) ?? 0) || content !== model.getText());
		return async savedText => {
			const reconcile = async () => {
				do {
					generation = this.resourceGenerations.get(key) ?? 0;
					content = model.getText();
					// File writes are asynchronous: even an undo can invalidate the prepared checkpoint.
					await this.persist(model.uri, undefined, () => textBackup(model, metadata));
				} while (generation !== (this.resourceGenerations.get(key) ?? 0) || content !== model.getText());
				recovery?.acknowledge(model.version);
			};
			do {
				await reconcile();
				try {
					await this.persist(model.uri, undefined, () => {
						if (model.getText() !== savedText) return textBackup(model, metadata);
						const dirty = this.workingCopies.get(model.uri).find(candidate => candidate.isDirty && candidate.backup() !== savedText);
						return dirty ? { resource: dirty.resource, kind: dirty.backupKind, content: dirty.backup(), updatedAt: Date.now(), ...(dirty.backupLanguageId ? { languageId: dirty.backupLanguageId } : {}), ...(dirty.backupContentType ? { contentType: dirty.backupContentType } : {}), ...(dirty.backupLabel ? { label: dirty.backupLabel } : {}) } : undefined;
					});
				} catch (error) {
					// A failed discard can outlive new edits; retain their acknowledged content before reporting it.
					try { await reconcile(); }
					catch (checkpointError) { throw new AggregateError([error, checkpointError], 'Recovery discard and current checkpoint failed'); }
					throw error;
				}
			} while (generation !== (this.resourceGenerations.get(key) ?? 0) || content !== model.getText());
		};
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
		this.resourceGenerations.clear();
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
		this.changed(copy.resource);
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
		this.changed(copy.resource);
		// A failed recovery can unregister a clean copy. Its durable content still needs recovery.
		if (!this.edited.delete(copy)) return;
		if (this.paused) { this.pendingResources.set(copy.resource.toString(), copy.resource); return; }
		const remaining = this.workingCopies.get(copy.resource);
		void this.persist(copy.resource, remaining.find(candidate => candidate.isDirty) ?? remaining[0]).catch(this.onError);
	}

	private schedule(copy: IWorkingCopy): void {
		if (this.stopped || this.isDisposed) return;
		this.changed(copy.resource);
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

	private changed(resource: URI): void {
		this.generation++;
		const key = resource.toString();
		this.resourceGenerations.set(key, (this.resourceGenerations.get(key) ?? 0) + 1);
	}

	private persist(resource: IWorkingCopy['resource'], copy?: IWorkingCopy, capture?: () => WorkingCopyBackup | undefined): Promise<void> {
		for (const candidate of this.workingCopies.get(resource)) this.cancel(candidate);
		const key = resource.toString();
		this.pendingResources.delete(key);
		const dirtyCopy = copy?.isDirty ? copy : this.workingCopies.get(resource).find(candidate => candidate.isDirty);
		let operation: () => Promise<void>;
		try {
			if (capture) {
				// Checkpoints sample only when their existing resource queue reaches this operation.
				operation = () => {
					const backup = capture();
					return backup ? this.backups.store(backup) : this.backups.delete(resource);
				};
			} else if (dirtyCopy) {
				const backup = { resource: dirtyCopy.resource, kind: dirtyCopy.backupKind, content: dirtyCopy.backup(), updatedAt: Date.now(), ...(dirtyCopy.backupLanguageId ? { languageId: dirtyCopy.backupLanguageId } : {}), ...(dirtyCopy.backupContentType ? { contentType: dirtyCopy.backupContentType } : {}), ...(dirtyCopy.backupLabel ? { label: dirtyCopy.backupLabel } : {}) };
				operation = () => this.backups.store(backup);
			} else {
				operation = () => {
					// Ordinary clean/unregister timers must not discard fault data owned by a pending save.
					if (this.retainRecovery?.(resource)) {
						this.pendingResources.set(key, resource);
						return Promise.resolve();
					}
					return this.backups.delete(resource);
				};
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

function textBackup(model: TextModel, metadata: Pick<WorkingCopyBackup, 'contentType' | 'label'>): WorkingCopyBackup {
	return { resource: model.uri, kind: 'text', content: model.getText(), updatedAt: Date.now(), languageId: model.getLanguageId(), ...(metadata.contentType ? { contentType: metadata.contentType } : {}), ...(metadata.label ? { label: metadata.label } : {}) };
}
