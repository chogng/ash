import { h } from "../../../base/browser/dom.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import {
	type IProgressService,
	type ProgressChange,
	type ProgressHandle,
	type ProgressOptions,
	type ProgressSnapshot,
	type ProgressUpdate,
} from "../common/progress.js";

interface ProgressRecord {
	readonly controller: AbortController;
	active: boolean;
	snapshot: ProgressSnapshot;
}

/** Browser-backed progress surface for one Workbench root. */
export class BrowserProgressService extends Disposable implements IProgressService {
	private readonly _onDidChange = this._register(new Emitter<ProgressChange>());
	private readonly tasks = new Map<number, ProgressRecord>();
	private readonly element: HTMLDivElement;
	private nextId = 1;

	readonly onDidChange: Event<ProgressChange> = this._onDidChange.event;

	constructor(container: HTMLElement) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, "div");
		this.element.className = "ash-progress-host";
		this.element.setAttribute("role", "region");
		this.element.setAttribute("aria-label", "Progress");
		container.append(this.element);
		const removeElement = (): void => this.element.remove();
		this._register({ dispose: removeElement, [Symbol.dispose]: removeElement });
	}

	startProgress(options: ProgressOptions): ProgressHandle {
		this.assertNotDisposed();
		validateProgressOptions(options);
		const id = this.nextId++;
		const controller = new AbortController();
		const record: ProgressRecord = {
			controller,
			active: true,
			snapshot: Object.freeze({
				id,
				title: options.title,
				...(options.total === undefined ? {} : { total: options.total }),
				worked: 0,
				cancellable: options.cancellable === true,
				cancelled: false,
				done: false,
			}),
		};
		this.tasks.set(id, record);
		this._onDidChange.fire({ kind: "started", progress: record.snapshot });
		this.render();
		let finished = false;
		const done = (): void => {
			if (finished) return;
			finished = true;
			record.active = false;
			const current = this.tasks.get(id);
			if (!current) return;
			current.snapshot = Object.freeze({ ...current.snapshot, done: true });
			this.tasks.delete(id);
			this._onDidChange.fire({ kind: "done", progress: current.snapshot });
			this.render();
		};
		const cancel = (): void => {
			if (finished || !record.snapshot.cancellable) return;
			record.active = false;
			controller.abort();
			record.snapshot = Object.freeze({ ...record.snapshot, cancelled: true });
			this._onDidChange.fire({ kind: "updated", progress: record.snapshot });
			done();
		};
		return {
			id,
			signal: controller.signal,
			report: update => {
				if (finished || !record.active) return;
				updateProgress(record, update);
				this._onDidChange.fire({ kind: "updated", progress: record.snapshot });
				this.render();
			},
			done,
			cancel,
			dispose: done,
			[Symbol.dispose]: done,
		};
	}

	async withProgress<T>(
		options: ProgressOptions,
		task: (progress: Pick<ProgressHandle, "report">, signal: AbortSignal) => Promise<T> | T,
	): Promise<T> {
		const handle = this.startProgress(options);
		try {
			return await task(handle, handle.signal);
		} finally {
			handle.done();
		}
	}

	protected override disposeCore(): void {
		for (const task of this.tasks.values()) {
			task.active = false;
			task.controller.abort();
		}
		this.tasks.clear();
		this.element.replaceChildren();
		super.disposeCore();
	}

	private render(): void {
		if (this.isDisposed) return;
		const document = this.element.ownerDocument;
		this.element.replaceChildren(...[...this.tasks.values()].map(record => {
			const item = h(document, "div");
			item.className = "ash-progress-item";
			const title = h(document, "span");
			title.className = "ash-progress-title";
			title.textContent = record.snapshot.title;
			item.append(title);
			if (record.snapshot.message) {
				const message = h(document, "span");
				message.className = "ash-progress-message";
				message.textContent = record.snapshot.message;
				item.append(message);
			}
			if (record.snapshot.total !== undefined) {
				const progress = h(document, "progress");
				progress.max = record.snapshot.total;
				progress.value = Math.min(record.snapshot.total, record.snapshot.worked);
				item.append(progress);
			} else {
				const spinner = h(document, "span");
				spinner.className = "ash-progress-indeterminate";
				spinner.setAttribute("aria-hidden", "true");
				item.append(spinner);
			}
			if (record.snapshot.cancellable) {
				const cancel = h(document, "button");
				cancel.type = "button";
				cancel.className = "ash-progress-cancel";
				cancel.textContent = "Cancel";
				cancel.addEventListener("click", () => this.tasks.get(record.snapshot.id) && this.cancel(record.snapshot.id));
				item.append(cancel);
			}
			return item;
		}));
	}

	private cancel(id: number): void {
		const task = this.tasks.get(id);
		if (!task) return;
		task.active = false;
		task.controller.abort();
		task.snapshot = Object.freeze({ ...task.snapshot, cancelled: true, done: true });
		this.tasks.delete(id);
		this._onDidChange.fire({ kind: "done", progress: task.snapshot });
		this.render();
	}
}

function validateProgressOptions(options: ProgressOptions): void {
	if (typeof options.title !== "string" || options.title.trim().length === 0) throw new TypeError("Progress title must not be empty");
	if (options.total !== undefined && (!Number.isFinite(options.total) || options.total <= 0)) throw new RangeError("Progress total must be positive");
}

function updateProgress(record: ProgressRecord, update: ProgressUpdate): void {
	if (update.increment !== undefined && (!Number.isFinite(update.increment) || update.increment < 0)) throw new RangeError("Progress increment must not be negative");
	if (update.total !== undefined && (!Number.isFinite(update.total) || update.total <= 0)) throw new RangeError("Progress total must be positive");
	const total = update.total ?? record.snapshot.total;
	const worked = record.snapshot.worked + (update.increment ?? 0);
	record.snapshot = Object.freeze({
		...record.snapshot,
		...(update.message === undefined ? {} : { message: update.message }),
		...(total === undefined ? {} : { total }),
		worked,
	});
}
