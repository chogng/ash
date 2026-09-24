import { getActiveWindow } from '../../../base/browser/dom.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../platform/log/common/log.js';

export interface ITaskQueue extends IDisposable {
	enqueue(task: () => boolean | void): void;
	flush(): void;
	clear(): void;
}

interface ITaskDeadline {
	timeRemaining(): number;
}
type CallbackWithDeadline = (deadline: ITaskDeadline) => void;

abstract class TaskQueue extends Disposable implements ITaskQueue {
	private _tasks: (() => boolean | void)[] = [];
	private _idleCallback?: number;
	private _i = 0;

	constructor(private readonly _logService: ILogService) {
		super();
		this._register(toDisposable(() => this.clear()));
	}

	protected abstract _requestCallback(callback: CallbackWithDeadline): number;
	protected abstract _cancelCallback(identifier: number): void;

	public enqueue(task: () => boolean | void): void {
		this._tasks.push(task);
		this._start();
	}

	public flush(): void {
		while (this._i < this._tasks.length) {
			if (!this._tasks[this._i]()) this._i++;
		}
		this.clear();
	}

	public clear(): void {
		if (this._idleCallback) {
			this._cancelCallback(this._idleCallback);
			this._idleCallback = undefined;
		}
		this._i = 0;
		this._tasks.length = 0;
	}

	private _start(): void {
		if (!this._idleCallback) this._idleCallback = this._requestCallback(this._process.bind(this));
	}

	private _process(deadline: ITaskDeadline): void {
		this._idleCallback = undefined;
		let taskDuration = 0;
		let longestTask = 0;
		let lastDeadlineRemaining = deadline.timeRemaining();
		let deadlineRemaining = 0;
		while (this._i < this._tasks.length) {
			taskDuration = Date.now();
			if (!this._tasks[this._i]()) this._i++;
			taskDuration = Math.max(1, Date.now() - taskDuration);
			longestTask = Math.max(taskDuration, longestTask);
			deadlineRemaining = deadline.timeRemaining();
			if (longestTask * 1.5 > deadlineRemaining) {
				if (lastDeadlineRemaining - taskDuration < -20) {
					this._logService.warn(`task queue exceeded allotted deadline by ${Math.abs(Math.round(lastDeadlineRemaining - taskDuration))}ms`);
				}
				this._start();
				return;
			}
			lastDeadlineRemaining = deadlineRemaining;
		}
		this.clear();
	}
}

export class PriorityTaskQueue extends TaskQueue {
	protected _requestCallback(callback: CallbackWithDeadline): number {
		return getActiveWindow().setTimeout(() => callback(this._createDeadline(16)));
	}

	protected _cancelCallback(identifier: number): void {
		getActiveWindow().clearTimeout(identifier);
	}

	private _createDeadline(duration: number): ITaskDeadline {
		const end = Date.now() + duration;
		return { timeRemaining: () => Math.max(0, end - Date.now()) };
	}
}

class IdleTaskQueueInternal extends TaskQueue {
	protected _requestCallback(callback: IdleRequestCallback): number {
		return getActiveWindow().requestIdleCallback(callback);
	}

	protected _cancelCallback(identifier: number): void {
		getActiveWindow().cancelIdleCallback(identifier);
	}
}

export const IdleTaskQueue = ('requestIdleCallback' in getActiveWindow()) ? IdleTaskQueueInternal : PriorityTaskQueue;

/** Creates an idle queue bound to the editor view's own window. */
export function createIdleTaskQueue(ownerWindow: Window): ITaskQueue {
	return new WindowTaskQueue(ownerWindow);
}

class WindowTaskQueue extends Disposable implements ITaskQueue {
	private readonly tasks: (() => boolean | void)[] = [];
	private callback: number | undefined;
	private index = 0;

	constructor(private readonly ownerWindow: Window) {
		super();
		this._register(toDisposable(() => this.clear()));
	}

	public enqueue(task: () => boolean | void): void {
		this.tasks.push(task);
		this.start();
	}

	public flush(): void {
		while (this.index < this.tasks.length) {
			if (!this.tasks[this.index]()) this.index++;
		}
		this.clear();
	}

	public clear(): void {
		if (this.callback !== undefined) this.cancel(this.callback);
		this.callback = undefined;
		this.index = 0;
		this.tasks.length = 0;
	}

	private start(): void {
		if (this.callback === undefined) {
			this.callback = this.request(deadline => this.process(deadline));
		}
	}

	private process(deadline: ITaskDeadline): void {
		this.callback = undefined;
		while (this.index < this.tasks.length && deadline.timeRemaining() > 0) {
			if (!this.tasks[this.index]()) this.index++;
		}
		if (this.index < this.tasks.length) this.start();
		else this.clear();
	}

	private request(callback: CallbackWithDeadline): number {
		const requestIdleCallback = (this.ownerWindow as Window & { requestIdleCallback?: (callback: CallbackWithDeadline) => number }).requestIdleCallback;
		return requestIdleCallback
			? requestIdleCallback.call(this.ownerWindow, callback)
			: this.ownerWindow.setTimeout(() => callback({ timeRemaining: () => 1 }), 0);
	}

	private cancel(identifier: number): void {
		const cancelIdleCallback = (this.ownerWindow as Window & { cancelIdleCallback?: (identifier: number) => void }).cancelIdleCallback;
		if (cancelIdleCallback) cancelIdleCallback.call(this.ownerWindow, identifier);
		else this.ownerWindow.clearTimeout(identifier);
	}
}

export class DebouncedIdleTask {
	private _queue: ITaskQueue;

	constructor(instantiationService: IInstantiationService) {
		this._queue = instantiationService.invokeFunction(accessor => new IdleTaskQueue(accessor.get(ILogService)));
	}

	public set(task: () => boolean | void): void {
		this._queue.clear();
		this._queue.enqueue(task);
	}

	public flush(): void {
		this._queue.flush();
	}
}
