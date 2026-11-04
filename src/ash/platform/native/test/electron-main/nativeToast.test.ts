import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'mocha';
import type { Notification } from 'electron/main';
import { Emitter } from '../../../../base/common/event.js';
import { CANCEL_TOAST_CHANNEL, SHOW_TOAST_CHANNEL } from '../../common/native.js';
import { nativeToastRoutes } from '../../electron-main/nativeToast.js';

class TestToast extends EventEmitter {
	shown = false;
	closed = false;
	show(): void { this.shown = true; }
	close(): void { this.closed = true; }
}

function windowRoutes(isFocused = () => false, activation?: Emitter<void>) {
	const toasts: TestToast[] = [];
	let reset: () => void = () => { };
	const routes = nativeToastRoutes(() => {
		const toast = new TestToast();
		toasts.push(toast);
		return { notification: toast as unknown as Notification, onDidActivate: activation?.event };
	}, listener => { reset = listener; }, isFocused);
	const show = routes.find(route => route.channel === SHOW_TOAST_CHANNEL)!;
	const cancel = routes.find(route => route.channel === CANCEL_TOAST_CHANNEL)!;
	return {
		toasts,
		show: (value: unknown) => show.invoke(show.validate(value)),
		cancel: (value: unknown) => cancel.invoke(cancel.validate(value)),
		reset: () => reset(),
	};
}

test('Native toasts deduplicate across windows and still return an Action Center click after the banner times out', async () => {
	const first = windowRoutes();
	const second = windowRoutes();
	const options = { id: 'request-1', title: 'Session', body: 'Completed', dedupeKey: 'session-turn' };
	try {
		const original = first.show(options);
		assert.equal(first.toasts[0].shown, true);
		second.cancel(options.id);
		first.toasts[0].emit('close', { reason: 'timedOut' });
		assert.deepEqual(await second.show({ ...options, id: 'request-2' }), { supported: true, clicked: false, suppressed: true });
		assert.equal(second.toasts.length, 0);
		first.toasts[0].emit('click');
		assert.deepEqual(await original, { supported: true, clicked: true });
	} finally { first.reset(); second.reset(); }
});

test('A Windows activation callback can finish a live toast after its banner times out', async () => {
	using activation = new Emitter<void>();
	const window = windowRoutes(() => false, activation);
	const pending = window.show({ id: 'action-center', title: 'Session' });
	window.toasts[0].emit('close', { reason: 'timedOut' });
	activation.fire();
	assert.deepEqual(await pending, { supported: true, clicked: true });
	assert.equal(activation.hasListeners(), false);
});

test('Native toast delivery uses the originating window focus at the time of showing', async () => {
	let focused = true;
	const window = windowRoutes(() => focused);
	const options = { id: 'focus-test', title: 'Session', onlyWhenUnfocused: true };
	assert.deepEqual(await window.show(options), { supported: true, clicked: false });
	assert.equal(window.toasts.length, 0);
	focused = false;
	const pending = window.show(options);
	assert.equal(window.toasts[0].shown, true);
	window.cancel(options.id);
	await pending;
});

test('Native toast routes reject malformed input and release pending toasts on renderer reset', async () => {
	const window = windowRoutes();
	assert.throws(() => window.show({ id: 'invalid/id', title: 'Session' }), /toast request ID/);
	assert.throws(() => window.show({ id: 'valid', title: 'Session', body: {} }), /toast options/);
	const pending = window.show({ id: 'valid', title: 'Session', dedupeKey: 'reset' });
	window.reset();
	assert.deepEqual(await pending, { supported: true, clicked: false });
	assert.equal(window.toasts[0].closed, true);
	assert.equal(window.toasts[0].listenerCount('click'), 0);
	const retry = window.show({ id: 'next', title: 'Session', dedupeKey: 'reset' });
	window.toasts[1].emit('failed');
	assert.deepEqual(await retry, { supported: false, clicked: false });
});
