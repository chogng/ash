import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DomEmitter } from '../../browser/event.js';
import { DisposableTracker, installDisposableTracker } from '../../common/lifecycle.js';

test('DomEmitter attaches while observed and detaches with its final listener', () => {
	const target = new CountingEventTarget();
	using emitter = new DomEmitter(target, 'click');
	const received: string[] = [];
	assert.equal(target.nativeListenerCount, 0);
	const first = emitter.event(() => received.push('first'));
	assert.equal(target.nativeListenerCount, 1);
	const second = emitter.event(() => received.push('second'));
	assert.equal(target.nativeListenerCount, 1);

	target.dispatchEvent(new Event('click'));
	assert.deepEqual(received, ['first', 'second']);
	first.dispose();
	assert.equal(target.nativeListenerCount, 1);
	target.dispatchEvent(new Event('click'));
	assert.deepEqual(received, ['first', 'second', 'second']);
	second.dispose();
	assert.equal(target.nativeListenerCount, 0);
	target.dispatchEvent(new Event('click'));
	assert.deepEqual(received, ['first', 'second', 'second']);

	const final = emitter.event(() => undefined);
	assert.equal(target.nativeListenerCount, 1);
	emitter.dispose();
	assert.equal(target.nativeListenerCount, 0);
	final.dispose();
	assert.throws(() => emitter.event(() => undefined), ReferenceError);
});

test('DomEmitter tracks its Emitter as one leaf-owned resource', () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	const emitter = new DomEmitter(new CountingEventTarget(), 'keydown');
	const innerEmitter = tracker.leaks().find(leak => leak.label === 'Emitter');

	assert.equal(innerEmitter?.ownerLabel, 'DomEmitter');
	emitter.dispose();
	tracker.assertNoLeaks();
});

class CountingEventTarget extends EventTarget {
	public nativeListenerCount = 0;

	public override addEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | AddEventListenerOptions,
	): void {
		this.nativeListenerCount += 1;
		super.addEventListener(type, callback, options);
	}

	public override removeEventListener(
		type: string,
		callback: EventListenerOrEventListenerObject | null,
		options?: boolean | EventListenerOptions,
	): void {
		this.nativeListenerCount -= 1;
		super.removeEventListener(type, callback, options);
	}
}
