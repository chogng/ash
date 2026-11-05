import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { scheduleChatAnimationFrame } from '../../../browser/widget/chatProgressAnimation.js';

test('chat progress shares one window frame and keeps its cadence after a late frame', () => {
	using requests = new DisposableStore();
	const window = new ProgressWindow();
	const calls: number[] = [];
	requests.add(scheduleChatAnimationFrame(window.value, () => {
		calls.push(1);
		requests.add(scheduleChatAnimationFrame(window.value, () => calls.push(3)));
	}));
	requests.add(scheduleChatAnimationFrame(window.value, () => calls.push(2)));
	assert.equal(window.frames.length, 1);
	window.paint(40);
	assert.deepEqual(calls, [1, 2]);
	assert.equal(window.frames.length, 0);
	assert.deepEqual([...window.timers.values()].map(timer => timer.at), [67]);
	window.advance(66);
	assert.equal(window.frames.length, 0);
	window.advance(67);
	window.paint(70);
	assert.deepEqual(calls, [1, 2, 3]);
});

test('chat progress cancels work across a flush and isolates windows', () => {
	using requests = new DisposableStore();
	const first = new ProgressWindow();
	const second = new ProgressWindow();
	const later = requests.add(new MutableDisposable());
	const calls: string[] = [];
	requests.add(scheduleChatAnimationFrame(first.value, () => later.clear()));
	later.value = scheduleChatAnimationFrame(first.value, () => calls.push('cancelled in flush'));
	requests.add(scheduleChatAnimationFrame(second.value, () => calls.push('second window')));
	first.paint(0);
	assert.equal(calls.length, 0);
	requests.add(scheduleChatAnimationFrame(first.value, () => calls.push('cancelled timer'))).dispose();
	assert.equal(first.timers.size, 0);
	second.paint(0);
	assert.deepEqual(calls, ['second window']);
});

class ProgressWindow {
	private time = 0;
	private timerId = 0;
	readonly frames: FrameRequestCallback[] = [];
	readonly timers = new Map<number, { at: number; run: () => void; }>();
	readonly value = {
		performance: { now: () => this.time },
		requestAnimationFrame: (run: FrameRequestCallback) => this.frames.push(run),
		setTimeout: (run: () => void, delay: number) => {
			const id = ++this.timerId;
			this.timers.set(id, { at: this.time + delay, run });
			return id;
		},
		clearTimeout: (id: number) => this.timers.delete(id),
	} as unknown as Window;

	advance(time: number): void {
		this.time = time;
		for (const [id, timer] of this.timers) {
			if (timer.at > time) continue;
			this.timers.delete(id);
			timer.run();
		}
	}

	paint(time: number): void {
		this.advance(time);
		for (const run of this.frames.splice(0)) run(time);
	}
}
