import { TerminalCapability } from '../../../../../../platform/terminal/common/capabilities/capabilities.js';
import { BufferMarkCapability } from '../../../../../../platform/terminal/common/capabilities/bufferMarkCapability.js';
import { TerminalCapabilityStore } from '../../../../../../platform/terminal/common/capabilities/terminalCapabilityStore.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { IMarker, Terminal } from '@xterm/xterm';
import { XtermTerminal } from '../../../browser/xterm/xtermTerminal.js';
import { DecorationAddon } from '../../../browser/xterm/decorationAddon.js';
import { MarkNavigationAddon } from '../../../browser/xterm/markNavigationAddon.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../../base/common/event.js';

ensureNoDisposablesAreLeakedInTestSuite();

function createScreen(lifetime: DisposableStore, viewportY: number, lines: readonly { readonly key: string; readonly line: number; readonly isDisposed?: boolean; }[], bufferType: 'normal' | 'alternate' = 'normal') {
	const scrolls: number[] = [];
	const active = { type: bufferType, viewportY };
	let markerIndex = 0;
	const terminal = {
		buffer: { active },
		scrollToLine(line: number) { active.viewportY = line; scrolls.push(line); },
		registerMarker() {
			const item = lines[markerIndex++]!;
			return { id: markerIndex, line: item.line, isDisposed: item.isDisposed ?? false, onDispose: Event.None, dispose() { } } satisfies IMarker;
		},
		registerDecoration() { return undefined; },
	} as unknown as Terminal;
	const capabilities = lifetime.add(new TerminalCapabilityStore());
	capabilities.add(TerminalCapability.BufferMarkDetection, lifetime.add(new BufferMarkCapability(terminal)));
	const decorations = lifetime.add(new DecorationAddon(capabilities));
	decorations.activate(terminal);
	for (const { key } of lines) {
		const [process, commandId = key] = key.split(':');
		decorations.registerCommandDecoration({ commandId, status: 'running', exitCode: undefined }, Number(process) || 0, terminal.registerMarker(0)!);
	}
	const navigation = lifetime.add(new MarkNavigationAddon(() => decorations.markers));
	navigation.activate(terminal);
	const screen = Object.create(XtermTerminal.prototype) as XtermTerminal;
	Reflect.set(screen, 'markNavigationAddon', navigation);
	return { screen, scrolls };
}

test('Terminal command navigation moves by live command markers and stops at either end', () => {
	using lifetime = new DisposableStore();
	const { screen, scrolls } = createScreen(lifetime, 80, [
		{ key: '11:command-1', line: 10 },
		{ key: '11:command-2', line: 40 },
		{ key: '11:command-3', line: 70 },
		{ key: '11:command-4', line: 90 },
		{ key: 'trimmed-command', line: 75, isDisposed: true },
	]);

	screen.scrollToPreviousCommand();
	screen.scrollToNextCommand();
	screen.scrollToNextCommand();

	assert.deepEqual(scrolls, [70, 90]);
});

test('Terminal command navigation keeps repeated command IDs from reused PTYs separate', () => {
	using lifetime = new DisposableStore();
	const { screen, scrolls } = createScreen(lifetime, 100, [
		{ key: '21:command-1', line: 30 },
		{ key: '22:command-1', line: 70 },
	]);

	screen.scrollToPreviousCommand();
	screen.scrollToPreviousCommand();

	assert.deepEqual(scrolls, [70, 30]);
});

test('Terminal command navigation leaves the alternate screen untouched', () => {
	using lifetime = new DisposableStore();
	const { screen, scrolls } = createScreen(lifetime, 80, [{ key: '11:command-1', line: 40 }], 'alternate');
	screen.scrollToPreviousCommand();
	screen.scrollToNextCommand();
	assert.deepEqual(scrolls, []);
});
