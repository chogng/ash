import { disposableWindowTimeout } from "../../../../base/browser/scheduler.js";
import { DisposableMap, Disposable, MutableDisposable, DisposableStore, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type IWorkingCopy, type IWorkingCopyService } from "../common/workingCopyService.js";
import { type IWorkingCopyBackupService } from "../common/workingCopyBackupService.js";

const BACKUP_DELAY_MS = 250;

/** Tracks dirty working copies and maintains their durable crash backups. */
export class WorkingCopyBackupTracker extends Disposable {
	private readonly tracked = this._register(new DisposableMap<IWorkingCopy, DisposableStore>());
	private readonly timers = new Map<IWorkingCopy, MutableDisposable<IDisposable>>();
	private readonly queues = new Map<string, Promise<void>>();

	constructor(private readonly workingCopies: IWorkingCopyService, private readonly backups: IWorkingCopyBackupService, private readonly ownerWindow: Window, private readonly onError: (error: unknown) => void = error => console.error("Failed to update working-copy backup", error)) {
		super();
		this._register(workingCopies.onDidRegister(copy => this.track(copy)));
		this._register(workingCopies.onDidUnregister(copy => this.untrack(copy)));
		for (const copy of workingCopies.getAll()) this.track(copy);
		this._register(toDisposable(() => {
			this.timers.clear();
		}));
	}

	flush(): Promise<void> {
		return Promise.all(this.workingCopies.getAll().map(copy => this.persist(copy))).then(() => Promise.all(this.queues.values())).then(() => undefined);
	}

	private track(copy: IWorkingCopy): void {
		if (this.tracked.has(copy)) return;
		const listeners = new DisposableStore();
		this.timers.set(copy, listeners.add(new MutableDisposable<IDisposable>()));
		listeners.add(copy.onDidChangeContent(() => this.schedule(copy)));
		listeners.add(copy.onDidChangeDirty(() => this.schedule(copy)));
		this.tracked.set(copy, listeners);
		this.schedule(copy);
	}

	private untrack(copy: IWorkingCopy): void {
		this.cancel(copy);
		this.tracked.deleteAndDispose(copy);
		this.timers.delete(copy);
		void this.persist(copy).catch(this.onError);
	}

	private schedule(copy: IWorkingCopy): void {
		this.cancel(copy);
		const timer = this.timers.get(copy);
		if (!timer) return;
		timer.value = disposableWindowTimeout(this.ownerWindow, () => {
			timer.clear();
			void this.persist(copy).catch(this.onError);
		}, BACKUP_DELAY_MS);
	}

	private cancel(copy: IWorkingCopy): void {
		this.timers.get(copy)?.clear();
	}

	private persist(copy: IWorkingCopy): Promise<void> {
		this.cancel(copy);
		const key = copy.resource.toString();
		let operation: () => Promise<void>;
		try {
			if (copy.isDirty) {
				const backup = { resource: copy.resource, kind: copy.backupKind, content: copy.backup(), updatedAt: Date.now(), ...(copy.backupLanguageId ? { languageId: copy.backupLanguageId } : {}), ...(copy.backupContentType ? { contentType: copy.backupContentType } : {}), ...(copy.backupLabel ? { label: copy.backupLabel } : {}) };
				operation = () => this.backups.store(backup);
			} else {
				operation = () => this.backups.delete(copy.resource);
			}
		} catch (error) {
			return Promise.reject(error);
		}
		const queued = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
		this.queues.set(key, queued);
		return queued.finally(() => { if (this.queues.get(key) === queued) this.queues.delete(key); });
	}
}
