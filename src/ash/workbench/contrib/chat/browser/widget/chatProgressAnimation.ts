import { disposableWindowTimeout, scheduleAtNextAnimationFrame } from '../../../../../base/browser/scheduler.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { type IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';

const frameInterval = 1000 / 30;
const queues = new WeakMap<Window, ProgressFrames>();

/** Schedules progress work on the owning window's shared 30 Hz clock. */
export function scheduleChatAnimationFrame(targetWindow: Window, callback: () => void): IDisposable {
	let queue = queues.get(targetWindow);
	if (!queue) {
		queue = new ProgressFrames(targetWindow);
		queues.set(targetWindow, queue);
	}
	return queue.add(callback);
}

class ProgressFrames {
	private readonly callbacks = new Set<() => void>();
	private scheduled: IDisposable | undefined;
	private nextFrame = 0;
	private flushing = false;

	constructor(private readonly targetWindow: Window) { }

	add(callback: () => void): IDisposable {
		// Each registration can be cancelled independently, even for the same callback.
		const run = () => callback();
		this.callbacks.add(run);
		if (!this.scheduled && !this.flushing) this.schedule();
		return toDisposable(() => {
			if (this.callbacks.delete(run) && !this.callbacks.size) {
				this.scheduled?.dispose();
				this.scheduled = undefined;
			}
		});
	}

	private schedule(): void {
		const delay = Math.ceil(this.nextFrame - this.targetWindow.performance.now());
		const request = () => {
			this.scheduled?.dispose();
			this.scheduled = scheduleAtNextAnimationFrame(this.targetWindow, () => this.flush());
		};
		if (delay > 0) this.scheduled = disposableWindowTimeout(this.targetWindow, request, delay);
		else request();
	}

	private flush(): void {
		this.scheduled?.dispose();
		this.scheduled = undefined;
		// Align to the window's time origin so a late display frame does not shift the cadence.
		const slot = Math.floor(this.targetWindow.performance.now() / frameInterval);
		this.nextFrame = (slot + 1) * frameInterval;
		this.flushing = true;
		try {
			for (const run of [...this.callbacks]) {
				if (!this.callbacks.delete(run)) continue;
				try { run(); } catch (error) { onUnexpectedError(error); }
			}
		} finally {
			this.flushing = false;
			if (this.callbacks.size) this.schedule();
		}
	}
}
