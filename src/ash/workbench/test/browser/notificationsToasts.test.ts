import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { PendingNotificationToasts } from '../../browser/parts/notifications/pendingNotificationToasts.js';

test('pending notification work is cancelled before rendering removed records, hidden surfaces, or disposed windows', () => {
	const callbacks: (() => void)[] = [];
	const current = new Set([1, 2, 3]);
	const rendered: number[] = [];
	let cancelled = 0;
	using pending = new PendingNotificationToasts<number>(item => current.has(item), callback => {
		callbacks.push(callback);
		return toDisposable(() => { cancelled++; });
	});
	const render = (item: number, resources: DisposableStore): void => { rendered.push(item); resources.dispose(); };
	pending.add(1, render);
	pending.add(2, render);
	pending.remove(1);
	current.delete(2);
	callbacks.splice(0).forEach(callback => callback());
	assert.deepEqual(rendered, []);
	assert.equal(cancelled, 2);
	pending.add(3, render);
	pending.clear();
	callbacks.splice(0).forEach(callback => callback());
	assert.deepEqual(rendered, []);
	pending.add(3, render);
	pending.dispose();
	callbacks.splice(0).forEach(callback => callback());
	assert.deepEqual(rendered, []);
	assert.equal(cancelled, 4);
});

test('a stale toast callback cannot consume replacement work, and rendering transfers its resource lifetime', () => {
	const callbacks: (() => void)[] = [];
	const rendered: string[] = [];
	using accepted = new DisposableStore();
	using pending = new PendingNotificationToasts<string>(() => true, callback => {
		callbacks.push(callback);
		return toDisposable(() => { });
	});
	pending.add('same', (_item, resources) => { resources.dispose(); assert.fail('Replaced work rendered'); });
	pending.add('same', (item, resources) => { rendered.push(item); accepted.add(resources); });
	callbacks[0]();
	assert.deepEqual(rendered, []);
	callbacks[1]();
	assert.deepEqual(rendered, ['same']);
	let released = false;
	accepted.add(toDisposable(() => { released = true; }));
	pending.clear();
	assert.equal(released, false);
	accepted.dispose();
	assert.equal(released, true);
});

test('a synchronous toast scheduler and a failed renderer release their cancellation resources', () => {
	let cancelled = 0;
	using immediate = new PendingNotificationToasts<number>(() => true, callback => {
		callback();
		return toDisposable(() => { cancelled++; });
	});
	immediate.add(1, (_item, resources) => resources.dispose());
	assert.equal(cancelled, 1);
	const callbacks: (() => void)[] = [];
	using queued = new PendingNotificationToasts<number>(() => true, callback => {
		callbacks.push(callback);
		return toDisposable(() => { cancelled++; });
	});
	queued.add(2, () => { throw new Error('Rendering failed'); });
	assert.throws(callbacks[0], /Rendering failed/);
	assert.equal(cancelled, 2);
});
