import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setup, teardown, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { type IDisposable } from '../../../base/common/lifecycle.js';
import { NullLoggerService } from '../../../platform/log/common/log.js';
import { installEditorTestDom } from './editorTestGlobals.js';

let browserEnvironment: JSDOM;
let installedGlobals: IDisposable;
let ownerWindow: Window;

setup(() => {
	browserEnvironment = new JSDOM('<!doctype html><body></body>');
	installedGlobals = installEditorTestDom(browserEnvironment, []);
	ownerWindow = browserEnvironment.window as unknown as Window;
});

teardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});

test('IdleTaskQueue imports before browser bootstrap but construction still requires a window', () => {
	// This process has no DOM fixture, unlike the scheduling tests below.
	const moduleUrl = new URL('../../browser/gpu/taskQueue.js', import.meta.url).href;
	const result = spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`
		import assert from 'node:assert/strict';
		assert.equal(globalThis.window, undefined);
		const { IdleTaskQueue } = await import(${JSON.stringify(moduleUrl)});
		assert.equal(globalThis.window, undefined);
		assert.throws(() => new IdleTaskQueue({}), /A browser window is required/);
	`,
		],
		{ encoding: 'utf8' },
	);
	assert.equal(result.error, undefined);
	assert.equal(result.signal, null);
	assert.equal(result.status, 0, result.stderr);
});

test('IdleTaskQueue uses browser idle deadlines and repeats unfinished tasks in order', async () => {
	let pending: IdleRequestCallback | undefined;
	let requests = 0;
	Object.assign(ownerWindow, {
		requestIdleCallback: (callback: IdleRequestCallback) => {
			pending = callback;
			return ++requests;
		},
		cancelIdleCallback: () => assert.fail('A completed idle callback must not be cancelled'),
	});
	const { IdleTaskQueue } = await import('../../browser/gpu/taskQueue.js');
	using queue = new IdleTaskQueue(new NullLoggerService());
	const calls: string[] = [];
	let remaining = 2;
	queue.enqueue(() => {
		calls.push('first');
		return --remaining > 0;
	});
	queue.enqueue(() => {
		calls.push('second');
	});
	assert.equal(requests, 1);
	pending!({ didTimeout: false, timeRemaining: () => 50 });
	assert.deepEqual(calls, ['first', 'first', 'second']);
	assert.equal(requests, 1);
});

test('IdleTaskQueue flush, clear and dispose cancel pending idle work', async () => {
	let requests = 0;
	const cancelled: number[] = [];
	Object.assign(ownerWindow, {
		requestIdleCallback: () => ++requests,
		cancelIdleCallback: (identifier: number) => cancelled.push(identifier),
	});
	const { IdleTaskQueue } = await import('../../browser/gpu/taskQueue.js');
	const queue = new IdleTaskQueue(new NullLoggerService());
	let calls = 0;
	try {
		queue.enqueue(() => {
			calls++;
		});
		queue.flush();
		queue.enqueue(() => {
			calls++;
		});
		queue.clear();
		queue.enqueue(() => {
			calls++;
		});
	} finally {
		queue.dispose();
	}
	assert.equal(calls, 1);
	assert.deepEqual(cancelled, [1, 2, 3]);
});

test('IdleTaskQueue selects the priority timeout fallback when idle callbacks are unavailable', async () => {
	Reflect.deleteProperty(ownerWindow, 'requestIdleCallback');
	Reflect.deleteProperty(ownerWindow, 'cancelIdleCallback');
	let pending: (() => void) | undefined;
	let requests = 0;
	Object.assign(ownerWindow, {
		setTimeout: (callback: () => void) => {
			pending = callback;
			return ++requests;
		},
		clearTimeout: () => assert.fail('A completed timeout must not be cancelled'),
	});
	const { IdleTaskQueue } = await import('../../browser/gpu/taskQueue.js');
	using queue = new IdleTaskQueue(new NullLoggerService());
	const calls: string[] = [];
	let remaining = 2;
	queue.enqueue(() => {
		calls.push('first');
		return --remaining > 0;
	});
	queue.enqueue(() => {
		calls.push('second');
	});
	assert.equal(requests, 1);
	pending!();
	assert.deepEqual(calls, ['first', 'first', 'second']);
	assert.equal(requests, 1);
});

test('IdleTaskQueue fallback flush, clear and dispose cancel pending timeouts', async () => {
	Reflect.deleteProperty(ownerWindow, 'requestIdleCallback');
	Reflect.deleteProperty(ownerWindow, 'cancelIdleCallback');
	let requests = 0;
	const cancelled: number[] = [];
	Object.assign(ownerWindow, {
		setTimeout: () => ++requests,
		clearTimeout: (identifier: number) => cancelled.push(identifier),
	});
	const { IdleTaskQueue } = await import('../../browser/gpu/taskQueue.js');
	const queue = new IdleTaskQueue(new NullLoggerService());
	let calls = 0;
	try {
		queue.enqueue(() => {
			calls++;
		});
		queue.flush();
		queue.enqueue(() => {
			calls++;
		});
		queue.clear();
		queue.enqueue(() => {
			calls++;
		});
	} finally {
		queue.dispose();
	}
	assert.equal(calls, 1);
	assert.deepEqual(cancelled, [1, 2, 3]);
});
