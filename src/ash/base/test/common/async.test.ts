import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createCancelablePromise, DeferredPromise, Delayer, disposableTimeout, first, promiseWithResolvers, raceCancellation, raceCancellationError, RunOnceScheduler, TaskQueue, TimeoutTimer, timeout } from '../../common/async.js';
import { isCancellationError } from '../../common/errors.js';
import { CancellationToken, CancellationTokenSource } from '../../common/cancellation.js';
import { Emitter } from '../../common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

suite('Cancellation races', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('aborting releases the listener while the underlying work is still pending', async () => {
		const work = promiseWithResolvers<void>();
		const cancellation = new AbortController();
		const reason = new Error('caller stopped');
		const pending = raceCancellationError(work.promise, cancellation.signal);
		assert.equal(getEventListeners(cancellation.signal, 'abort').length, 1);
		cancellation.abort(reason);
		await assert.rejects(pending, error => isCancellationError(error) && error.reason === reason);
		assert.equal(getEventListeners(cancellation.signal, 'abort').length, 0);
		work.reject(new Error('late failure'));
	});

	test('token cancellation releases its subscription before the work ends', async () => {
		using source = new CancellationTokenSource();
		const work = promiseWithResolvers<void>();
		const pending = raceCancellationError(work.promise, source.token);
		source.cancel();
		await assert.rejects(pending, isCancellationError);
		work.resolve();
	});

	test('success and failure both release cancellation listeners', async () => {
		const cancellation = new AbortController();
		assert.equal(await raceCancellationError(Promise.resolve(42), cancellation.signal), 42);
		const failure = new Error('work failed');
		await assert.rejects(raceCancellationError(Promise.reject(failure), cancellation.signal), error => error === failure);
		assert.equal(getEventListeners(cancellation.signal, 'abort').length, 0);
	});

	test('a resolved cancellation race releases its token subscription before returning', async () => {
		using cancellation = new Emitter<void>();
		const token = { isCancellationRequested: false, onCancellationRequested: cancellation.event };
		assert.equal(await raceCancellation(Promise.resolve(42), token), 42);
		assert.equal(cancellation.hasListeners(), false);
		cancellation.fire();
	});

	test('a rejected cancellation race preserves the work error and releases its subscription', async () => {
		using cancellation = new Emitter<void>();
		const token = { isCancellationRequested: false, onCancellationRequested: cancellation.event };
		const failure = new Error('clipboard read failed');
		await assert.rejects(raceCancellation(Promise.reject(failure), token), error => error === failure);
		assert.equal(cancellation.hasListeners(), false);
		cancellation.fire();
	});

	for (const outcome of ['resolve', 'reject'] as const) {
		test(`cancellation keeps its default and releases the listener before a late ${outcome}`, async () => {
			using cancellation = new Emitter<void>();
			const token = { isCancellationRequested: false, onCancellationRequested: cancellation.event };
			const work = promiseWithResolvers<string>();
			const pending = raceCancellation(work.promise, token, 'cancelled');
			assert.equal(cancellation.hasListeners(), true);
			try {
				token.isCancellationRequested = true;
				cancellation.fire();
				assert.equal(cancellation.hasListeners(), false);
				assert.equal(await pending, 'cancelled');
				cancellation.fire();
				if (outcome === 'resolve') {
					work.resolve('late clipboard text');
				} else {
					work.reject(new Error('late clipboard failure'));
				}
				assert.equal(await pending, 'cancelled');
			} finally {
				work.resolve('cleanup');
				await work.promise.catch(() => undefined);
				await Promise.resolve();
			}
		});
	}

	test('a pre-cancelled race observes late rejection without an unhandled rejection', () => {
		const asyncModule = new URL('../../common/async.js', import.meta.url).href;
		const cancellationModule = new URL('../../common/cancellation.js', import.meta.url).href;
		const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', `
			import assert from 'node:assert/strict';
			import { raceCancellation, promiseWithResolvers } from ${JSON.stringify(asyncModule)};
			import { CancellationToken } from ${JSON.stringify(cancellationModule)};
			const work = promiseWithResolvers();
			assert.equal(await raceCancellation(work.promise, CancellationToken.Cancelled, 'cancelled'), 'cancelled');
			work.reject(new Error('late clipboard failure'));
			await new Promise(resolve => setImmediate(resolve));
		`], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
	});

	test('a pre-cancelled race keeps its default when work has already resolved', async () => {
		assert.equal(await raceCancellation(Promise.resolve('clipboard text'), CancellationToken.Cancelled, 'cancelled'), 'cancelled');
	});

	test('cancellation during listener registration releases the returned subscription', async () => {
		using cancellation = new Emitter<void>();
		const token: CancellationToken & { isCancellationRequested: boolean; } = {
			isCancellationRequested: false,
			onCancellationRequested: listener => {
				const subscription = cancellation.event(listener);
				token.isCancellationRequested = true;
				cancellation.fire();
				return subscription;
			},
		};
		assert.equal(await raceCancellation(Promise.resolve('late clipboard text'), token, 'cancelled'), 'cancelled');
		assert.equal(cancellation.hasListeners(), false);
	});

	for (const outcome of ['resolve', 'reject', 'cancel'] as const) {
		test(`cleanup reentry cannot replace the ${outcome} that won the cancellation race`, async () => {
			let removals = 0;
			using cancellation = new Emitter<void>({
				onWillRemoveListener: () => {
					removals++;
					token.isCancellationRequested = true;
					cancellation.fire();
				},
			});
			const token = { isCancellationRequested: false, onCancellationRequested: cancellation.event };
			const work = promiseWithResolvers<string>();
			const failure = new Error('work failed');
			const pending = raceCancellation(work.promise, token, 'cancelled');
			if (outcome === 'resolve') {
				work.resolve('work result');
				assert.equal(await pending, 'work result');
			} else if (outcome === 'reject') {
				work.reject(failure);
				await assert.rejects(pending, error => error === failure);
			} else {
				token.isCancellationRequested = true;
				cancellation.fire();
				assert.equal(await pending, 'cancelled');
				work.resolve('late result');
				assert.equal(await pending, 'cancelled');
			}
			assert.deepEqual({ removals, hasListeners: cancellation.hasListeners() }, { removals: 1, hasListeners: false });
		});
	}

	for (const outcome of ['resolve', 'reject', 'cancel', 'registration', 'reporter'] as const) {
		test(`throwing cleanup preserves the ${outcome} outcome and reports its failure without an unhandled rejection`, () => {
			const asyncModule = new URL('../../common/async.js', import.meta.url).href;
			const eventModule = new URL('../../common/event.js', import.meta.url).href;
			const errorsModule = new URL('../../common/errors.js', import.meta.url).href;
			const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '--eval', `
				import assert from 'node:assert/strict';
				import { raceCancellation, promiseWithResolvers } from ${JSON.stringify(asyncModule)};
				import { Emitter } from ${JSON.stringify(eventModule)};
				import { errorHandler, setUnexpectedErrorHandler } from ${JSON.stringify(errorsModule)};
				const outcome = ${JSON.stringify(outcome)};
				const cleanupError = new Error('subscription cleanup failed');
				const workError = new Error('work failed');
				const reportingError = new Error('reporting failed');
				const reported = [];
				const consoleReports = [];
				const originalHandler = errorHandler.getUnexpectedErrorHandler();
				const originalConsoleError = console.error;
				setUnexpectedErrorHandler(error => {
					reported.push(error);
					if (outcome === 'reporter') throw reportingError;
				});
				console.error = (...args) => consoleReports.push(args);
				let removals = 0;
				using cancellation = new Emitter({
					onDidRemoveLastListener() {
						removals++;
						throw cleanupError;
					},
				});
				const token = {
					isCancellationRequested: false,
					onCancellationRequested: listener => {
						const subscription = cancellation.event(listener);
						if (outcome === 'registration') {
							token.isCancellationRequested = true;
							cancellation.fire();
						}
						return subscription;
					},
				};
				try {
					const work = promiseWithResolvers();
					const results = [];
					const pending = raceCancellation(work.promise, token, 'cancelled');
					pending.then(value => results.push(value), error => results.push(error));
					if (outcome === 'cancel') {
						token.isCancellationRequested = true;
						cancellation.fire();
					} else if (outcome === 'reject') {
						work.reject(workError);
					} else if (outcome !== 'registration') {
						work.resolve('work result');
					}
					await new Promise(resolve => setImmediate(resolve));
					let expected = 'work result';
					if (outcome === 'reject') {
						expected = workError;
					} else if (outcome === 'cancel' || outcome === 'registration') {
						expected = 'cancelled';
					}
					assert.deepEqual({
						results,
						reported,
						consoleErrors: consoleReports.map(args => args.slice(1)),
						removals,
						hasListeners: cancellation.hasListeners(),
					}, {
						results: [expected],
						reported: [cleanupError],
						consoleErrors: outcome === 'reporter' ? [[cleanupError, reportingError]] : [],
						removals: 1,
						hasListeners: false,
					});
					work.resolve('late result');
					cancellation.fire();
					await new Promise(resolve => setImmediate(resolve));
					assert.deepEqual({ results, removals, reported }, { results: [expected], removals: 1, reported: [cleanupError] });
				} finally {
					setUnexpectedErrorHandler(originalHandler);
					console.error = originalConsoleError;
				}
			`], { encoding: 'utf8', timeout: 10_000 });
			assert.equal(result.status, 0, result.stderr);
		});
	}

	test('cancellation releases its subscription while the underlying promise never ends', async () => {
		using source = new CancellationTokenSource();
		const work = promiseWithResolvers<string>();
		const pending = raceCancellation(work.promise, source.token);
		source.cancel();
		assert.equal(await pending, undefined);
		source.cancel();
		source.dispose();
	});
});

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
	const deferred = new DeferredPromise<{ dispose(): void; }>();
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
