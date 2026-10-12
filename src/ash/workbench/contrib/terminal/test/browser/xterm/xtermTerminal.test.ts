import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { IMarker, Terminal } from '@xterm/xterm';
import { XtermTerminal } from '../../../browser/xterm/xtermTerminal.js';

function createScreen(viewportY: number, lines: readonly { readonly key: string; readonly line: number; readonly isDisposed?: boolean; }[], bufferType: 'normal' | 'alternate' = 'normal') {
	const scrolls: number[] = [];
	const active = { type: bufferType, viewportY };
	const terminal = {
		buffer: { active },
		scrollToLine(line: number) { active.viewportY = line; scrolls.push(line); },
	} as unknown as Terminal;
	const screen = Object.create(XtermTerminal.prototype) as XtermTerminal;
	Reflect.set(screen, 'terminal', terminal);
	Reflect.set(screen, 'commandMarkers', new Map(lines.map(({ key, line, isDisposed }) => [key, { line, isDisposed: isDisposed ?? false } as unknown as IMarker])));
	return { screen, scrolls };
}

test('Terminal command navigation moves by live command markers and stops at either end', () => {
	const { screen, scrolls } = createScreen(80, [
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
	const { screen, scrolls } = createScreen(100, [
		{ key: '21:command-1', line: 30 },
		{ key: '22:command-1', line: 70 },
	]);

	screen.scrollToPreviousCommand();
	screen.scrollToPreviousCommand();

	assert.deepEqual(scrolls, [70, 30]);
});

test('Terminal command navigation leaves the alternate screen untouched', () => {
	const { screen, scrolls } = createScreen(80, [{ key: '11:command-1', line: 40 }], 'alternate');
	screen.scrollToPreviousCommand();
	screen.scrollToNextCommand();
	assert.deepEqual(scrolls, []);
});
