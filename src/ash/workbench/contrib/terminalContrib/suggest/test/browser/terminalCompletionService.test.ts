import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import type { ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import { TerminalCompletionService, type ITerminalCompletion } from '../../browser/terminalCompletionService.js';

test('Terminal completions isolate synchronous and asynchronous provider failures', async () => {
	using service = new TerminalCompletionService();
	using broken = service.registerTerminalCompletionProvider('extension', 'broken', {
		provideCompletions: () => { throw new Error('Synchronous failure'); },
	});
	using rejected = service.registerTerminalCompletionProvider('extension', 'rejected', {
		provideCompletions: async () => { throw new Error('Asynchronous failure'); },
	});
	using healthy = service.registerTerminalCompletionProvider('extension', 'healthy', {
		provideCompletions: async () => [{ label: 'status', replacementRange: [4, 6] }],
	});
	const results = await service.provideCompletions({} as ITerminalInstance, 'git st', 6, new AbortController().signal);
	assert.deepEqual(results.map(({ isValid, ...item }) => item), [{ label: 'status', replacementRange: [4, 6] }]);
	assert.equal(results[0]!.isValid?.(), true);
});

test('Terminal completions do not dispatch an already cancelled request', async () => {
	using service = new TerminalCompletionService();
	let calls = 0;
	using registration = service.registerTerminalCompletionProvider('extension', 'provider', {
		provideCompletions: async () => { calls++; return []; },
	});
	const request = new AbortController();
	request.abort();
	assert.deepEqual(await service.provideCompletions({} as ITerminalInstance, '', 0, request.signal), []);
	assert.equal(calls, 0);
});

test('Terminal completions discard results from a registration that was replaced while pending', async () => {
	using service = new TerminalCompletionService();
	const pending = new DeferredPromise<readonly ITerminalCompletion[]>();
	const provider = { provideCompletions: () => pending.p };
	using original = service.registerTerminalCompletionProvider('extension', 'provider', provider, '.');
	const operation = service.provideCompletions({} as ITerminalInstance, '.', 1, new AbortController().signal, '.');
	original.dispose();
	using replacement = service.registerTerminalCompletionProvider('extension', 'provider', provider, '.');
	await pending.complete([{ label: 'stale', replacementRange: [0, 1] }]);
	assert.deepEqual(await operation, []);
	const results = await service.provideCompletions({} as ITerminalInstance, '.', 1, new AbortController().signal, '.');
	assert.equal(results[0]!.isValid?.(), true);
	replacement.dispose();
	assert.equal(results[0]!.isValid?.(), false);
});

for (const transition of ['cancel', 'unregister', 'dispose'] as const) {
	test(`Terminal completions settle after ${transition} even when a provider ignores cancellation`, async () => {
		using service = new TerminalCompletionService();
		const pending = new DeferredPromise<readonly ITerminalCompletion[]>();
		let providerSignal: AbortSignal | undefined;
		using registration = service.registerTerminalCompletionProvider('extension', 'pending', {
			provideCompletions: (_instance, _value, _cursor, signal) => { providerSignal = signal; return pending.p; },
		});
		using healthy = service.registerTerminalCompletionProvider('extension', 'healthy', {
			provideCompletions: async () => [{ label: 'healthy', replacementRange: [0, 0] }],
		});
		const request = new AbortController();
		const operation = service.provideCompletions({} as ITerminalInstance, '', 0, request.signal);
		if (transition === 'cancel') request.abort();
		else if (transition === 'unregister') registration.dispose();
		else service.dispose();
		const result = await operation;
		assert.equal(providerSignal?.aborted, true);
		assert.deepEqual(result.map(item => item.label), transition === 'unregister' ? ['healthy'] : []);
		// The original work remains observed after cancellation, including late failures.
		await pending.error(new Error('Late provider failure'));
	});
}

test('Terminal completions reject registration after the window service is disposed', () => {
	using service = new TerminalCompletionService();
	service.dispose();
	assert.throws(() => service.registerTerminalCompletionProvider('extension', 'late', { provideCompletions: async () => [] }), isCancellationError);
	assert.deepEqual([...service.providers], []);
});
