import { TerminalCapabilityStore } from '../../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import assert from 'node:assert/strict';
import type { Terminal, IMarker } from '@xterm/xterm';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { DecorationAddon } from '../../../browser/xterm/decorationAddon.js';
import { TerminalCapability } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { BufferMarkCapability } from '../../../../../../platform/terminal/common/capabilities/bufferMarkCapability.js';

function rendererBoundary(lifetime: DisposableStore) {
	const created: { marker: IMarker; trimmed: Emitter<void>; render: Emitter<HTMLElement>; disposed: boolean; }[] = [];
	const terminal = {
		registerMarker() {
			const trimmed = lifetime.add(new Emitter<void>());
			const render = lifetime.add(new Emitter<HTMLElement>());
			let isDisposed = false;
			const marker: IMarker = {
				id: created.length + 1, line: created.length,
				get isDisposed() { return isDisposed; }, onDispose: trimmed.event,
				dispose() { if (!isDisposed) { isDisposed = true; trimmed.fire(); } },
			};
			created.push({ marker, trimmed, render, disposed: false });
			return marker;
		},
		registerDecoration(options: { marker: IMarker; }) {
			const item = created.find(item => item.marker === options.marker)!;
			return { element: undefined, onRender: item.render.event, dispose() { item.disposed = true; } };
		},
	};
	return { terminal: terminal as unknown as Terminal, created };
}

suite('Terminal command decoration lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buffer mark indexing withdraws trimmed marks and distinguishes created from borrowed markers', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const capability = lifetime.add(new BufferMarkCapability(boundary.terminal));
		const observed: IMarker[] = [];
		lifetime.add(capability.onMarkAdded(mark => observed.push(mark.marker!)));
		capability.addMark({ id: 'owned', hidden: true });
		const owned = capability.getMark('owned')!;
		const borrowed = boundary.terminal.registerMarker(0)!;
		capability.addMark({ id: 'borrowed', marker: borrowed });
		assert.deepEqual([...capability.markers()], [owned, borrowed]);
		assert.deepEqual(observed, [owned, borrowed]);
		borrowed.dispose();
		assert.equal(capability.getMark('borrowed'), undefined);
		assert.equal(boundary.created[1]!.trimmed.hasListeners(), false);
		const external = boundary.terminal.registerMarker(0)!;
		capability.addMark({ id: 'external', marker: external });
		capability.dispose();
		assert.equal(owned.isDisposed, true);
		assert.equal(external.isDisposed, false);
		assert.equal(boundary.created[2]!.trimmed.hasListeners(), false);
		assert.deepEqual([...capability.markers()], []);
		external.dispose();
	});

	test('replacing a named mark releases its original listener without stale disposal withdrawing the replacement', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const capability = lifetime.add(new BufferMarkCapability(boundary.terminal));
		const first = boundary.terminal.registerMarker(0)!;
		const replacement = boundary.terminal.registerMarker(0)!;
		capability.addMark({ id: 'same', marker: first });
		capability.addMark({ id: 'same', marker: replacement });
		assert.equal(boundary.created[0]!.trimmed.hasListeners(), false);
		first.dispose();
		assert.equal(capability.getMark('same'), replacement);
		replacement.dispose();
		assert.equal(capability.getMark('same'), undefined);
	});
	test('xterm trimming removes screen positions and releases callbacks immediately', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const capabilities = lifetime.add(new TerminalCapabilityStore());
		capabilities.add(TerminalCapability.BufferMarkDetection, lifetime.add(new BufferMarkCapability(boundary.terminal)));
		const addon = lifetime.add(new DecorationAddon(capabilities));
		addon.activate(boundary.terminal);
		const first = boundary.terminal.registerMarker(0)!;
		lifetime.add(toDisposable(() => first.dispose()));
		addon.registerCommandDecoration({ commandId: '1', status: 'running', exitCode: undefined }, 10, first);
		const item = boundary.created[0]!;
		assert.equal(item.trimmed.hasListeners(), true);
		assert.equal(item.render.hasListeners(), true);
		item.marker.dispose();
		assert.equal(addon.markers.length, 0);
		assert.equal(item.trimmed.hasListeners(), false);
		assert.equal(item.render.hasListeners(), false);
		assert.equal(item.disposed, true);
	});

	test('screen shutdown releases both PTY incarnations of a reused command ID', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const capabilities = lifetime.add(new TerminalCapabilityStore());
		capabilities.add(TerminalCapability.BufferMarkDetection, lifetime.add(new BufferMarkCapability(boundary.terminal)));
		const addon = lifetime.add(new DecorationAddon(capabilities));
		addon.activate(boundary.terminal);
		const first = boundary.terminal.registerMarker(0)!;
		lifetime.add(toDisposable(() => first.dispose()));
		addon.registerCommandDecoration({ commandId: '1', status: 'running', exitCode: undefined }, 10, first);
		addon.registerCommandDecoration({ commandId: '1', status: 'succeeded', exitCode: 0 }, 10, first);
		const second = boundary.terminal.registerMarker(0)!;
		lifetime.add(toDisposable(() => second.dispose()));
		addon.registerCommandDecoration({ commandId: '1', status: 'failed', exitCode: 3 }, 11, second);
		assert.equal(addon.markers.length, 2);
		addon.dispose();
		assert.equal(addon.markers.length, 0);
		assert.equal(first.isDisposed, false);
		assert.equal(second.isDisposed, false);
		lifetime.dispose();
		for (const item of boundary.created) {
			assert.equal(item.marker.isDisposed, true);
			assert.equal(item.render.hasListeners(), false);
			assert.equal(item.trimmed.hasListeners(), false);
			assert.equal(item.disposed, true);
		}
	});
});
