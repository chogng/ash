import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { JsonValue } from '../../../../../platform/agentHost/common/extensionHostApi.js';
import { TerminalProcessExtHostProxy } from '../../browser/terminalProcessExtHostProxy.js';

suite('Extension terminal process boundary', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('publishes synchronous open output and releases the opaque handle once on exit', async () => {
		using lifetime = new DisposableStore();
		const operations: { operation: string; payload: JsonValue; }[] = [];
		let released = 0;
		const child = lifetime.add(new TerminalProcessExtHostProxy(7, 'opaque-pty', true, 90, 30, async (operation, payload) => {
			operations.push({ operation, payload });
			return operation === 'openTaskTerminal' ? { events: [{ type: 'data', data: 'open output' }, { type: 'name', name: 'Provider title' }, { type: 'close', code: 7 }] } : null;
		}, () => released++));
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
		const child = lifetime.add(new TerminalProcessExtHostProxy(8, 'read-pty', false, 80, 24, async operation => {
			operations.push(operation);
			if (operation === 'openTaskTerminal') return { events: [] };
			if (operation === 'readTaskTerminal') { await readStarted.complete(); return read.p; }
			return null;
		}, () => released++));
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
		const child = lifetime.add(new TerminalProcessExtHostProxy(9, 'bounded-pty', true, 80, 24, async operation => operation === 'openTaskTerminal'
			? { events: [{ type: 'data', data: 'x'.repeat(262145) }] } : null, () => released++));
		const output: string[] = [];
		lifetime.add(child.onProcessData(data => output.push(data)));
		await assert.rejects(child.start(), TypeError);
		child.dispose();
		assert.deepEqual(output, []);
		assert.equal(released, 1);
	});
});
