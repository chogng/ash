import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { PixelRatio } from '../../browser/pixelRatio.js';

test('PixelRatio tracks each window and reports finite positive changes', () => {
	const ownerWindow = new JSDOM('<!doctype html><body></body>').window;
	Object.defineProperty(ownerWindow, 'devicePixelRatio', { configurable: true, value: 1 });
	const monitor = PixelRatio.getInstance(ownerWindow as unknown as Window);
	const changes: number[] = [];
	using listener = monitor.onDidChange(value => changes.push(value));

	Object.defineProperty(ownerWindow, 'devicePixelRatio', { configurable: true, value: 2 });
	assert.equal(monitor.value, 2);
	ownerWindow.dispatchEvent(new ownerWindow.Event('resize'));

	assert.deepEqual({ value: monitor.value, changes }, { value: 2, changes: [2] });
	ownerWindow.close();
});

test('PixelRatio rejects non-finite and non-positive browser geometry', () => {
	const ownerWindow = new JSDOM('<!doctype html><body></body>').window;
	Object.defineProperty(ownerWindow, 'devicePixelRatio', { configurable: true, value: Number.NaN });

	assert.throws(() => PixelRatio.getInstance(ownerWindow as unknown as Window), RangeError);
	Object.defineProperty(ownerWindow, 'devicePixelRatio', { configurable: true, value: 0 });
	assert.throws(() => PixelRatio.getInstance(ownerWindow as unknown as Window), RangeError);
	ownerWindow.close();
});

test('PixelRatio isolates windows and retires a monitor on pagehide', () => {
	const firstWindow = new JSDOM('<!doctype html><body></body>').window;
	const secondWindow = new JSDOM('<!doctype html><body></body>').window;
	Object.defineProperty(firstWindow, 'devicePixelRatio', { configurable: true, value: 1 });
	Object.defineProperty(secondWindow, 'devicePixelRatio', { configurable: true, value: 2 });
	const firstMonitor = PixelRatio.getInstance(firstWindow as unknown as Window);
	const secondMonitor = PixelRatio.getInstance(secondWindow as unknown as Window);

	assert.deepEqual({ first: firstMonitor.value, second: secondMonitor.value }, { first: 1, second: 2 });
	firstWindow.dispatchEvent(new firstWindow.Event('pagehide'));
	const replacement = PixelRatio.getInstance(firstWindow as unknown as Window);
	assert.notEqual(replacement, firstMonitor);

	firstWindow.close();
	secondWindow.close();
});
