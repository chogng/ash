import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { JsonValue } from '../../../../../platform/agentHost/common/extensionHostApi.js';
import { TerminalProcessExtHostProxy } from '../../browser/terminalProcessExtHostProxy.js';
import { Emitter } from '../../../../../base/common/event.js';
import { TerminalDataBufferer } from '../../../../../platform/terminal/common/terminalDataBuffering.js';
import { isCancellationError } from '../../../../../base/common/errors.js';

suite('Extension terminal process boundary', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buffer leases preserve text order and cannot stop a replacement with the same process ID', () => {
		using lifetime = new DisposableStore();
		const first = lifetime.add(new Emitter<string>());
		const second = lifetime.add(new Emitter<string>());
		const observed: [number, string][] = [];
		const bufferer = lifetime.add(new TerminalDataBufferer((id, text) => observed.push([id, text])));
		const oldLease = lifetime.add(bufferer.startBuffering(1, first.event));
		first.fire('中文');
		first.fire('🙂');
		lifetime.add(bufferer.startBuffering(1, second.event));
		assert.equal(first.hasListeners(), false);
		oldLease.dispose();
		second.fire('replacement');
		bufferer.stopBuffering(1);
		second.fire('late');
		assert.deepEqual(observed, [
			[1, '中文🙂'],
			[1, 'replacement'],
		]);
		assert.equal(second.hasListeners(), false);
	});

	test('adjacent extension output is drained before rename and process exit', async () => {
		using lifetime = new DisposableStore();
		const child = lifetime.add(
			new TerminalProcessExtHostProxy(
				7,
				'opaque-pty',
				true,
				90,
				30,
				async (operation): Promise<JsonValue> =>
					operation === 'openTaskTerminal'
						? {
								events: [
									{ type: 'data', data: 'first' },
									{ type: 'data', data: ' second' },
									{ type: 'name', name: 'Renamed' },
									{ type: 'data', data: ' tail' },
									{ type: 'close', code: 0 },
								],
							}
						: null,
				() => {},
			),
		);
		const observed: unknown[] = [];
		lifetime.add(child.onProcessData(data => observed.push(data)));
		lifetime.add(child.onDidChangeProperty(property => observed.push(property)));
		lifetime.add(child.onProcessExit(code => observed.push(code)));
		await child.start();
		assert.deepEqual(observed, ['first second', { type: 'title', value: 'Renamed' }, ' tail', 0]);
	});
	test('publishes synchronous open output and releases the opaque handle once on exit', async () => {
		using lifetime = new DisposableStore();
		const operations: { operation: string; payload: JsonValue }[] = [];
		let released = 0;
		const child = lifetime.add(
			new TerminalProcessExtHostProxy(
				7,
				'opaque-pty',
				true,
				90,
				30,
				async (operation, payload): Promise<JsonValue> => {
					operations.push({ operation, payload });
					return operation === 'openTaskTerminal'
						? {
								events: [
									{ type: 'data', data: 'open output' },
									{ type: 'name', name: 'Provider title' },
									{ type: 'close', code: 7 },
								],
							}
						: null;
				},
				() => released++,
			),
		);
		const observed: unknown[] = [];
		lifetime.add(child.onProcessReady(ready => observed.push(ready)));
		lifetime.add(child.onProcessData(data => observed.push(data)));
		lifetime.add(child.onDidChangeProperty(property => observed.push(property)));
		lifetime.add(child.onProcessExit(code => observed.push(code)));
		await child.start();
		child.shutdown(true);
		child.dispose();
		assert.deepEqual(observed, [{ pid: -1, cwd: '' }, 'open output', { type: 'title', value: 'Provider title' }, 7]);
		assert.deepEqual(operations, [
			{ operation: 'openTaskTerminal', payload: { ptyId: 'opaque-pty', dimensions: { columns: 90, rows: 30 } } },
			{ operation: 'closeTaskTerminal', payload: { ptyId: 'opaque-pty' } },
		]);
		assert.equal(released, 1);
	});

	test('closing during a read ignores late provider output and never opens another handle', async () => {
		using lifetime = new DisposableStore();
		const readStarted = new DeferredPromise<void>();
		const read = new DeferredPromise<JsonValue>();
		const operations: string[] = [];
		let released = 0;
		const child = lifetime.add(
			new TerminalProcessExtHostProxy(
				8,
				'read-pty',
				false,
				80,
				24,
				async operation => {
					operations.push(operation);
					if (operation === 'openTaskTerminal') return { events: [] };
					if (operation === 'readTaskTerminal') {
						await readStarted.complete();
						return read.p;
					}
					return null;
				},
				() => released++,
			),
		);
		const output: string[] = [];
		const exits: (number | undefined)[] = [];
		lifetime.add(child.onProcessData(data => output.push(data)));
		lifetime.add(child.onProcessExit(code => exits.push(code)));
		await child.start();
		await readStarted.p;
		assert.equal(child.input, undefined);
		child.shutdown(true);
		await read.complete({ events: [{ type: 'data', data: 'late output' }] });
		await Promise.resolve();
		child.dispose();
		assert.deepEqual(output, []);
		assert.deepEqual(exits, [undefined]);
		assert.equal(released, 1);
		assert.deepEqual(operations, ['openTaskTerminal', 'readTaskTerminal', 'closeTaskTerminal']);
	});

	test('rejects oversized provider data before publishing it', async () => {
		using lifetime = new DisposableStore();
		let released = 0;
		const child = lifetime.add(
			new TerminalProcessExtHostProxy(
				9,
				'bounded-pty',
				true,
				80,
				24,
				async operation => (operation === 'openTaskTerminal' ? { events: [{ type: 'data', data: 'x'.repeat(262145) }] } : null),
				() => released++,
			),
		);
		const output: string[] = [];
		lifetime.add(child.onProcessData(data => output.push(data)));
		await assert.rejects(child.start(), TypeError);
		child.dispose();
		assert.deepEqual(output, []);
		assert.equal(released, 1);
	});

	test('input and resize wait for provider confirmation in their original order', async () => {
		using lifetime = new DisposableStore();
		const started = new DeferredPromise<void>();
		const acknowledgement = new DeferredPromise<JsonValue>();
		const operations: { operation: string; payload: JsonValue }[] = [];
		const child = lifetime.add(
			new TerminalProcessExtHostProxy(
				10,
				'input-pty',
				true,
				80,
				24,
				async (operation, payload) => {
					operations.push({ operation, payload });
					if (operation === 'inputTaskTerminal') {
						await started.complete();
						return acknowledgement.p;
					}
					return { events: [] };
				},
				() => {},
			),
		);
		await child.start();
		let confirmed = false;
		const input = child.input!('中文\r').then(() => {
			confirmed = true;
		});
		await started.p;
		const resize = child.resize(100, 30);
		assert.equal(confirmed, false);
		assert.equal(
			operations.some(value => value.operation === 'resizeTaskTerminal'),
			false,
		);
		await acknowledgement.complete({ events: [] });
		await Promise.all([input, resize]);
		assert.equal(confirmed, true);
		assert.deepEqual(
			operations.filter(value => value.operation === 'inputTaskTerminal' || value.operation === 'resizeTaskTerminal'),
			[
				{ operation: 'inputTaskTerminal', payload: { data: '中文\r', ptyId: 'input-pty' } },
				{
					operation: 'resizeTaskTerminal',
					payload: { dimensions: { columns: 100, rows: 30 }, ptyId: 'input-pty' },
				},
			],
		);
	});

	test('a provider input failure reaches the caller and releases its PTY once', async () => {
		using lifetime = new DisposableStore();
		const failure = new Error('Provider rejected input');
		let released = 0;
		let closed = 0;
		const child = lifetime.add(
			new TerminalProcessExtHostProxy(
				11,
				'failed-input',
				true,
				80,
				24,
				async operation => {
					if (operation === 'inputTaskTerminal') throw failure;
					if (operation === 'closeTaskTerminal') closed++;
					return { events: [] };
				},
				() => released++,
			),
		);
		await child.start();
		await assert.rejects(child.input!('first'), error => error === failure);
		await assert.rejects(child.input!('late'), isCancellationError);
		child.shutdown(true);
		assert.deepEqual({ released, closed }, { released: 1, closed: 1 });
	});

	test('shutdown rejects in-flight and queued input before a late provider reply', async () => {
		using lifetime = new DisposableStore();
		const started = new DeferredPromise<void>();
		const acknowledgement = new DeferredPromise<JsonValue>();
		const input: string[] = [];
		const output: string[] = [];
		let inputSignal: AbortSignal | undefined;
		const child = lifetime.add(
			new TerminalProcessExtHostProxy(
				12,
				'closing-input',
				true,
				80,
				24,
				async (operation, payload, signal) => {
					if (operation === 'inputTaskTerminal') {
						input.push((payload as { data: string }).data);
						inputSignal = signal;
						await started.complete();
						return acknowledgement.p;
					}
					return { events: [] };
				},
				() => {},
			),
		);
		lifetime.add(child.onProcessData(data => output.push(data)));
		await child.start();
		const first = assert.rejects(child.input!('first'), isCancellationError);
		await started.p;
		const second = assert.rejects(child.input!('queued'), isCancellationError);
		child.shutdown(true);
		await Promise.all([first, second]);
		assert.equal(inputSignal?.aborted, true);
		await acknowledgement.complete({ events: [{ type: 'data', data: 'late' }] });
		await Promise.resolve();
		assert.deepEqual(input, ['first']);
		assert.deepEqual(output, []);
	});

	test('an accepted input reply can report exit without turning its acknowledgement into cancellation', async () => {
		using lifetime = new DisposableStore();
		const child = lifetime.add(
			new TerminalProcessExtHostProxy(
				13,
				'exit-input',
				true,
				80,
				24,
				async operation => ({
					events: operation === 'inputTaskTerminal' ? [{ type: 'close', code: 0 }] : [],
				}),
				() => {},
			),
		);
		await child.start();
		await child.input!('exit\r');
		await assert.rejects(child.input!('late'), isCancellationError);
	});
});
