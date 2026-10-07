import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { type ICommandService } from '../../../../platform/commands/common/commands.js';
import { normalizeExtensionHostPayload, normalizeExtensionHostSnapshot, normalizeExtensionStatusBarUpdate, type ExtensionStatusBarEntry } from '../../../../platform/extensionHost/common/extensionHostApi.js';
import { MainThreadStatusBar } from '../../browser/mainThreadStatusBar.js';
import { StatusbarAlignment, StatusbarService } from '../../../services/statusbar/browser/statusbar.js';

const source = { extensionId: 'acme.status', activationGeneration: 1, incarnation: 1 };
const entry = (value: number): ExtensionStatusBarEntry => ({ id: 'item', text: `Status ${value}`, tooltip: 'Run status', ariaLabel: 'Run extension status', alignment: 'right', priority: 1.5, command: { command: 'acme.run', arguments: [{ value }] } });
function commandService(callback: (...args: unknown[]) => Promise<void>): ICommandService {
	return { onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async <T>(id: string, ...args: readonly unknown[]) => { await callback(id, ...args); return undefined as T; } };
}
function snapshot(incarnation = 1, entries: readonly ExtensionStatusBarEntry[] = [entry(0)]) {
	return normalizeExtensionHostSnapshot({
		generation: incarnation, extensions: [{
			id: source.extensionId, version: '1', packageDigest: `sha256:${'a'.repeat(64)}`, runtimeApiVersion: 1,
			activationGeneration: 1, incarnation, lifecycle: 'ready', failure: null, stderr: '', outputEvents: [],
			registrations: [{ kind: 'statusBar', registrationId: 'status', revision: 1, entries }],
		}]
	});
}

suite('Extension status bar', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('replacements reuse one accessor, hidden entries disappear and stale snapshots cannot restore them', async () => {
		using statusbar = new StatusbarService();
		const calls: unknown[][] = [];
		const commands = commandService(async (...args) => { calls.push(args); });
		using bridge = new MainThreadStatusBar(error => assert.fail(String(error)), statusbar, commands);
		let additions = 0;
		const add = statusbar.addEntry.bind(statusbar);
		statusbar.addEntry = (value, options) => { additions++; return add(value, options); };
		bridge.update(snapshot());
		for (let revision = 2; revision <= 100; revision++) bridge.set(source, 'status', revision, [entry(revision)]);
		assert.equal(additions, 1);
		assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 1);
		await statusbar.getEntries(StatusbarAlignment.Right)[0]!.entry.run!();
		assert.deepEqual(calls, [['acme.run', normalizeExtensionHostPayload({ value: 100 })]]);
		bridge.set(source, 'status', 101, []);
		bridge.update(snapshot());
		bridge.set(source, 'status', 100, [entry(100)]);
		assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
		bridge.clear();
	});

	test('an already started click completes with its arguments while retirement rejects new updates', async () => {
		using statusbar = new StatusbarService();
		const pending = new DeferredPromise<void>();
		const calls: unknown[][] = [];
		const commands = commandService(async (...args) => { calls.push(args); await pending.p; });
		using bridge = new MainThreadStatusBar(error => assert.fail(String(error)), statusbar, commands);
		bridge.update(snapshot());
		const oldRun = statusbar.getEntries(StatusbarAlignment.Right)[0]!.entry.run!;
		const click = oldRun();
		bridge.set(source, 'status', 2, [entry(2)]);
		bridge.update(snapshot(2, []));
		assert.throws(() => bridge.set(source, 'status', 3, [entry(3)]), /retired/);
		oldRun();
		await pending.complete();
		await click;
		assert.deepEqual(calls, [['acme.run', normalizeExtensionHostPayload({ value: 0 })]]);
		assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
	});

	test('malformed updates fail before changing live entries', () => {
		using statusbar = new StatusbarService();
		using bridge = new MainThreadStatusBar(error => assert.fail(String(error)), statusbar, commandService(async () => undefined));
		bridge.update(snapshot());
		const operation = { operation: 'setStatusBarEntries', registrationId: 'status', revision: 2, entries: [entry(2)] };
		for (const invalid of [
			{ ...operation, extensionId: 'other' }, { ...operation, revision: 0 },
			{ ...operation, entries: [entry(2), entry(2)] },
			{ ...operation, entries: [{ ...entry(2), priority: Infinity }] },
			{ ...operation, entries: [{ ...entry(2), text: '😀'.repeat(3000) }] },
			{ ...operation, entries: [{ ...entry(2), command: { command: 'acme.run', arguments: Array(1025).fill(null) } }] },
		]) assert.throws(() => normalizeExtensionStatusBarUpdate(invalid));
		assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]!.entry.text, 'Status 0');
	});

	test('disposal releases entries without reporting a late command failure to retired services', async () => {
		using statusbar = new StatusbarService();
		const pending = new DeferredPromise<void>();
		const errors: unknown[] = [];
		using bridge = new MainThreadStatusBar(error => errors.push(error), statusbar, commandService(() => pending.p));
		bridge.update(snapshot());
		const click = statusbar.getEntries(StatusbarAlignment.Right)[0]!.entry.run!();
		bridge.dispose();
		await pending.error(new Error('Retired command'));
		await click;
		assert.deepEqual(errors, []);
		assert.equal(statusbar.getEntries(StatusbarAlignment.Right).length, 0);
	});
});
