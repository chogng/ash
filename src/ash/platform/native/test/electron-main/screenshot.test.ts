import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { BrowserWindow } from 'electron/main';
import { getScreenshot } from '../../electron-main/nativeHostMainService.js';
import { validateScreenshotRectangle } from '../../common/nativeHost.js';

test('screenshot rectangles reject malformed IPC and cannot select another window', () => {
	assert.equal(validateScreenshotRectangle(undefined), undefined);
	const rect = { x: 0, y: 10, width: 20, height: 30 };
	assert.deepEqual(validateScreenshotRectangle(rect), rect);
	for (const value of [null, [], {}, { ...rect, windowId: 2 }, { ...rect, x: -1 }, { ...rect, y: Infinity }, { ...rect, width: 0 }, { ...rect, height: NaN }, { ...rect, width: '20' }]) {
		assert.throws(() => validateScreenshotRectangle(value), /Invalid screenshot rectangle/);
	}
});

test('window capture converts CSS pixels once, retains PNG bytes and checks the current bounds', async () => {
	const clips: unknown[] = [];
	const bytes = new Uint8Array([137, 80, 78, 71]);
	let closed = false;
	let zoom = 2;
	const window = {
		isDestroyed: () => closed,
		getContentBounds: () => ({ width: 800, height: 600 }),
		webContents: {
			isDestroyed: () => closed,
			getZoomFactor: () => zoom,
			capturePage: async (clip: unknown) => { clips.push(clip); return { toPNG: () => bytes, isEmpty: () => false }; },
		},
	} as unknown as BrowserWindow;
	assert.deepEqual((await getScreenshot(window, { x: 10, y: 20, width: 40, height: 30 }))?.buffer, bytes);
	assert.deepEqual(clips, [{ x: 20, y: 40, width: 80, height: 60 }]);
	await assert.rejects(getScreenshot(window, { x: 390, y: 0, width: 20, height: 10 }), /outside the window/);
	assert.equal(clips.length, 1);
	assert.deepEqual((await getScreenshot(window))?.buffer, bytes);
	assert.equal(clips[1], undefined);
	zoom = 1.25;
	await getScreenshot(window, { x: 20, y: 30, width: 160, height: 96 });
	assert.deepEqual(clips[2], { x: 25, y: 38, width: 200, height: 120 });
	closed = true;
	assert.equal(await getScreenshot(window), undefined);
	assert.equal(clips.length, 3);
});

test('a window closed during capture produces no late screenshot', async () => {
	let closed = false;
	const window = {
		isDestroyed: () => closed,
		getContentBounds: () => ({ width: 800, height: 600 }),
		webContents: {
			isDestroyed: () => closed, getZoomFactor: () => 1,
			capturePage: async () => { closed = true; return { toPNG: () => assert.fail('Closed window bytes must not be read') }; },
		},
	} as unknown as BrowserWindow;
	assert.equal(await getScreenshot(window), undefined);
});
