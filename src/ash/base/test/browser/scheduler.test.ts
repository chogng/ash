import assert from "node:assert/strict";
import { test } from "mocha";
import { WindowIdleValue, WindowIntervalTimer } from "../../browser/dom.js";
import { disposableWindowInterval, disposableWindowTimeout, measure, modify, runAtThisOrScheduleAtNextAnimationFrame, scheduleAtNextAnimationFrame } from "../../browser/scheduler.js";

test("animation-frame scheduling orders reads, ordinary work, and writes", () => {
	const targetWindow = new TestAnimationWindow();
	const order: string[] = [];
	modify(targetWindow.value, () => order.push("modify"));
	scheduleAtNextAnimationFrame(targetWindow.value, () => order.push("ordinary"));
	measure(targetWindow.value, () => order.push("measure"));

	targetWindow.flush();

	assert.deepEqual(order, ["measure", "ordinary", "modify"]);
});

test("current-frame scheduling joins an active flush by priority", () => {
	const targetWindow = new TestAnimationWindow();
	const order: string[] = [];
	scheduleAtNextAnimationFrame(targetWindow.value, () => {
		order.push("first");
		runAtThisOrScheduleAtNextAnimationFrame(targetWindow.value, () => order.push("same-frame-high"), 100);
		runAtThisOrScheduleAtNextAnimationFrame(targetWindow.value, () => order.push("same-frame-low"), -100);
	});
	scheduleAtNextAnimationFrame(targetWindow.value, () => order.push("queued"));

	targetWindow.flush();

	assert.deepEqual(order, ["first", "same-frame-high", "queued", "same-frame-low"]);
	assert.equal(targetWindow.pendingFrames, 0);
});

test("current-frame scheduling remains cancellable", () => {
	const targetWindow = new TestAnimationWindow();
	let called = false;
	scheduleAtNextAnimationFrame(targetWindow.value, () => {
		const registration = runAtThisOrScheduleAtNextAnimationFrame(targetWindow.value, () => called = true);
		registration.dispose();
	});

	targetWindow.flush();

	assert.equal(called, false);
});

test("animation-frame scheduling falls back to an owned window timer", () => {
	const targetWindow = new TestTimerWindow();
	let calls = 0;
	scheduleAtNextAnimationFrame(targetWindow.value, () => calls += 1);

	assert.equal(targetWindow.pendingTimers, 1);
	targetWindow.flush();
	assert.equal(calls, 1);
});

test("window timeouts remain cancellable", () => {
	const targetWindow = new TestTimerWindow();
	let called = false;
	const registration = disposableWindowTimeout(targetWindow.value, () => called = true, 10);

	registration.dispose();
	targetWindow.flush();
	assert.equal(called, false);
});

test("window intervals stop on a result or iteration limit", () => {
	const targetWindow = new TestTimerWindow();
	let selfStopping = 0;
	disposableWindowInterval(targetWindow.value, () => {
		selfStopping += 1;
		return true;
	}, 10);
	let limited = 0;
	disposableWindowInterval(targetWindow.value, () => { limited += 1; }, 10, 2);

	targetWindow.flushIntervals();
	targetWindow.flushIntervals();
	targetWindow.flushIntervals();

	assert.equal(selfStopping, 1);
	assert.equal(limited, 2);
});

test("window idle values compute at idle or immediately when requested", () => {
	const targetWindow = new TestTimerWindow();
	let executions = 0;
	const urgent = new WindowIdleValue(targetWindow.value, () => ++executions);
	assert.equal(urgent.isInitialized, false);
	assert.equal(urgent.value, 1);
	targetWindow.flush();
	assert.equal(executions, 1);

	const idle = new WindowIdleValue(targetWindow.value, () => ++executions);
	targetWindow.flush();
	assert.equal(idle.isInitialized, true);
	assert.equal(idle.value, 2);
});

test("WindowIntervalTimer scopes cancellation to the selected window", () => {
	const targetWindow = new TestTimerWindow();
	const timer = new WindowIntervalTimer();
	let calls = 0;
	timer.cancelAndSet(() => calls += 1, 10, targetWindow.value);
	targetWindow.flushIntervals();
	assert.equal(calls, 1);
	timer.dispose();
	targetWindow.flushIntervals();
	assert.equal(calls, 1);
});

class TestAnimationWindow {
	private nextHandle = 1;
	private callbacks = new Map<number, FrameRequestCallback>();

	readonly value = {
		requestAnimationFrame: (callback: FrameRequestCallback): number => {
			const handle = this.nextHandle++;
			this.callbacks.set(handle, callback);
			return handle;
		},
		queueMicrotask,
	} as unknown as Window;

	get pendingFrames(): number {
		return this.callbacks.size;
	}

	flush(): void {
		const callbacks = [...this.callbacks.values()];
		this.callbacks.clear();
		for (const callback of callbacks) callback(0);
	}
}

class TestTimerWindow {
	private nextHandle = 1;
	private callbacks = new Map<number, () => void>();
	private intervals = new Map<number, () => void>();

	readonly value = {
		setTimeout: (callback: () => void): number => {
			const handle = this.nextHandle++;
			this.callbacks.set(handle, callback);
			return handle;
		},
		clearTimeout: (handle: number): void => {
			this.callbacks.delete(handle);
		},
		setInterval: (callback: () => void): number => {
			const handle = this.nextHandle++;
			this.intervals.set(handle, callback);
			return handle;
		},
		clearInterval: (handle: number): void => {
			this.intervals.delete(handle);
		},
		performance: { now: () => 0 },
		queueMicrotask,
	} as unknown as Window;

	get pendingTimers(): number {
		return this.callbacks.size;
	}

	flush(): void {
		const callbacks = [...this.callbacks.values()];
		this.callbacks.clear();
		for (const callback of callbacks) callback();
	}

	flushIntervals(): void {
		for (const callback of [...this.intervals.values()]) callback();
	}
}
