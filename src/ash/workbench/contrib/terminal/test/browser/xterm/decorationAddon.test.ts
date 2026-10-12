import assert from 'node:assert/strict';
import type { Terminal, IMarker } from '@xterm/xterm';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { DecorationAddon } from '../../../browser/xterm/decorationAddon.js';

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
	test('xterm trimming removes screen positions and releases callbacks immediately', () => {
		using lifetime = new DisposableStore();
		const boundary = rendererBoundary(lifetime);
		const addon = lifetime.add(new DecorationAddon());
		addon.activate(boundary.terminal);
		addon.registerCommandDecoration({ commandId: '1', status: 'running', exitCode: undefined }, 10);
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
		const addon = lifetime.add(new DecorationAddon());
		addon.activate(boundary.terminal);
		addon.registerCommandDecoration({ commandId: '1', status: 'running', exitCode: undefined }, 10);
		addon.registerCommandDecoration({ commandId: '1', status: 'succeeded', exitCode: 0 }, 10);
		addon.registerCommandDecoration({ commandId: '1', status: 'failed', exitCode: 3 }, 11);
		assert.equal(addon.markers.length, 2);
		addon.dispose();
		assert.equal(addon.markers.length, 0);
		for (const item of boundary.created) {
			assert.equal(item.marker.isDisposed, true);
			assert.equal(item.render.hasListeners(), false);
			assert.equal(item.trimmed.hasListeners(), false);
			assert.equal(item.disposed, true);
		}
	});
});
