import { validateScreenshotShortcutRequest, validateScreenshotShortcutResult } from '../../common/screenshotProtocol.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import {
	validateScreenshotRequest,
	validateScreenshotCompletion,
	validateScreenshotImage,
	validateScreenshotInitialization
} from '../../common/screenshotProtocol.js';

test('manual capture IPC cannot select a window, inject appearance or accept unbounded PNG dimensions', () => {
	const request = {
		id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		styles: { '--ash-foreground': '#fff' },
		colorScheme: 'dark',
		accessibilityHints: true
	};
	assert.equal(validateScreenshotRequest(request), request);
	for (const value of [
		{ ...request, windowId: 3 },
		{ ...request, id: '../window' },
		{ ...request, styles: { background: 'red' } },
		{ ...request, styles: { '--ash-foreground': 'url(https://example.invalid)' } }
	])
		assert.throws(() => validateScreenshotRequest(value));
	assert.deepEqual(validateScreenshotCompletion({ kind: 'cancel' }), { kind: 'cancel' });
	assert.throws(() => validateScreenshotCompletion({ kind: 'save', path: '/tmp/capture.png' }));
	const image = new Uint8Array(33);
	image.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
	const view = new DataView(image.buffer);
	view.setUint32(16, 800);
	view.setUint32(20, 600);
	assert.equal(validateScreenshotImage(image), image);
	view.setUint32(16, 100_000);
	view.setUint32(20, 100_000);
	assert.throws(() => validateScreenshotImage(image), /too large/);
	assert.throws(
		() => validateScreenshotCompletion({ kind: 'attach', image: new Uint8Array(100) }),
		/Invalid screenshot PNG/
	);
});

test('overlay initialization accepts only image, appearance and its localization snapshot', () => {
	const image = new Uint8Array(33);
	image.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
	const header = new DataView(image.buffer);
	header.setUint32(16, 800);
	header.setUint32(20, 600);
	const initialization = {
		image,
		presentation: {
			id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			styles: {},
			colorScheme: 'hcDark',
			accessibilityHints: false
		},
		locale: 'zh-CN',
		bundles: { chat: { 'screenshot.title': '屏幕截图' } }
	};
	assert.equal(validateScreenshotInitialization(initialization), initialization);
	for (const value of [
		{ ...initialization, windowId: 3 },
		{ ...initialization, presentation: { ...initialization.presentation, windowId: 3 } },
		{ ...initialization, locale: '../invalid' },
		{ ...initialization, bundles: { chat: { title: 3 } } },
		{ ...initialization, image: new Uint8Array(100) }
	])
		assert.throws(() => validateScreenshotInitialization(value));
});


test('screenshot shortcut IPC accepts only bounded accelerators and actual registration results', () => {
	const request = { accelerator: 'Command+Control+A', label: 'Control+Command+A', global: true };
	assert.equal(validateScreenshotShortcutRequest(request), request);
	for (const value of [{ ...request, commandId: 'another.command' }, { ...request, accelerator: 'Command+Control+A;other' }, { ...request, global: 1 }]) assert.throws(() => validateScreenshotShortcutRequest(value));
	assert.deepEqual(validateScreenshotShortcutResult({ available: false, activeLabel: 'Control+Command+B' }), { available: false, activeLabel: 'Control+Command+B' });
	assert.throws(() => validateScreenshotShortcutResult({ available: 'yes', activeLabel: '' }));
});
