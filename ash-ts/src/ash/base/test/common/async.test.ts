import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createCancelablePromise, DeferredPromise, Delayer, disposableTimeout, first, promiseWithResolvers, RunOnceScheduler, TaskQueue, TimeoutTimer, timeout } from '../../common/async.js';
import { isCancellationError } from '../../common/errors.js';

test('timeout settles asynchronously', async () => {
	let settled = false;
	const pending = timeout(0).then(() => {
		settled = true;
	});

	assert.equal(settled, false);
	await pending;
	assert.equal(settled, true);
});

test('timeout can be cancelled', async () => {
	const pending = timeout(10_000);
	pending.cancel();

	await assert.rejects(pending, isCancellationError);
});

test('TimeoutTimer replaces work and rejects scheduling after disposal', () => {
	const calls: string[] = [];
	const timer = new TimeoutTimer();
	timer.cancelAndSet(() => calls.push('first'), 10_000);
	timer.cancelAndSet(() => calls.push('second'), 10_000);
	timer.cancel();
	assert.deepEqual(calls, []);
	timer.dispose();
	assert.throws(() => timer.cancelAndSet(() => undefined, 0), ReferenceError);
});

test('RunOnceScheduler debounces, flushes, and cancels owned work', () => {
	let runs = 0;
	const scheduler = new RunOnceScheduler(() => runs += 1, 10_000);
	scheduler.schedule();
	scheduler.schedule();
	assert.equal(scheduler.isScheduled(), true);
	scheduler.flush();
	assert.equal(runs, 1);
	assert.equal(scheduler.isScheduled(), false);
	scheduler.schedule();
	scheduler.dispose();
	assert.equal(scheduler.isScheduled(), false);
	assert.throws(() => scheduler.schedule(), ReferenceError);
});

test('createCancelablePromise rejects cancellation and disposes a late disposable result', async () => {
	const deferred = new DeferredPromise<{ dispose(): void }>();
	let disposed = false;
	const pending = createCancelablePromise(() => deferred.p);
	pending.cancel();
	await assert.rejects(pending, isCancellationError);
	await deferred.complete({ dispose: () => { disposed = true; } });
	await Promise.resolve();
	assert.equal(disposed, true);
});

test('DeferredPromise and promiseWithResolvers expose explicit single settlement', async () => {
	const deferred = new DeferredPromise<number>();
	assert.equal(deferred.isSettled, false);
	await deferred.complete(7);
	await deferred.complete(8);
	assert.equal(await deferred.p, 7);
	assert.equal(deferred.value, 7);

	const resolvers = promiseWithResolvers<string>();
	resolvers.resolve('done');
	assert.equal(await resolvers.promise, 'done');
});

test('Delayer coalesces triggers and TaskQueue serializes work', async () => {
	const delayer = new Delayer<number>(0);
	const firstTrigger = delayer.trigger(() => 1);
	const secondTrigger = delayer.trigger(() => 2);
	assert.equal(firstTrigger, secondTrigger);
	assert.equal(await secondTrigger, 2);
	delayer.dispose();

	const order: string[] = [];
	const queue = new TaskQueue();
	const firstTask = queue.schedule(async () => {
		order.push('first:start');
		await Promise.resolve();
		order.push('first:end');
		return 1;
	});
	const secondTask = queue.schedule(() => {
		order.push('second');
		return 2;
	});
	assert.deepEqual(await Promise.all([firstTask, secondTask]), [1, 2]);
	assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});

test('TaskQueue clears pending work with cancellation or undefined', async () => {
	const gate = new DeferredPromise<void>();
	const queue = new TaskQueue();
	const running = queue.schedule(() => gate.p);
	const cancelled = queue.schedule(() => 1);
	const skipped = queue.scheduleSkipIfCleared(() => 2);
	queue.clearPending();
	await gate.complete(undefined);
	await running;
	await assert.rejects(cancelled, isCancellationError);
	assert.equal(await skipped, undefined);
});

test('disposableTimeout is cancellable and first stops sequential evaluation', async () => {
	let called = false;
	const registration = disposableTimeout(() => { called = true; }, 0);
	registration.dispose();
	await timeout(1);
	assert.equal(called, false);
	const calls: number[] = [];
	assert.equal(await first([
		async () => { calls.push(1); return 0; },
		async () => { calls.push(2); return 2; },
		async () => { calls.push(3); return 3; },
	]), 2);
	assert.deepEqual(calls, [1, 2]);
});
