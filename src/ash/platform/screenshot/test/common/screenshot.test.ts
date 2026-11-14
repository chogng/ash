import assert from 'node:assert/strict';
import { test } from 'mocha';
import { validateScreenshotRequest, validateScreenshotPinRequest, validateScreenshotCompletion, validateScreenshotInitialization } from '../../common/screenshot.js';

function image(): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
	new DataView(bytes.buffer).setUint32(16, 800);
	new DataView(bytes.buffer).setUint32(20, 600);
	return bytes;
}
test('desktop capture accepts only a bundled screenshot request and bounded metadata', () => {
	const request = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', input: { defaultAction: 'copy' } };
	assert.equal(validateScreenshotRequest(request), request);
	for (const extra of [{ html: '<script>host()</script>' }, { renderer: 'extension' }, { source: 'content' }, { windowId: 3 }, { image: image() }]) {
		assert.throws(() => validateScreenshotRequest({ ...request, ...extra }));
	}
	assert.throws(() => validateScreenshotRequest({ ...request, input: { run: () => { } } }));
	assert.throws(() => validateScreenshotRequest({ ...request, input: { code: { lines: [] } } }));
});
test('pin and native output require bounded PNG pixels without accepting destinations', () => {
	const request = { image: image(), input: {} };
	assert.equal(validateScreenshotPinRequest(request), request);
	assert.equal(validateScreenshotCompletion({ kind: 'pin', image: request.image }).kind, 'pin');
	for (const invalid of [{ kind: 'save', image: request.image, filePath: '/tmp/private' }, { kind: 'execute' }, { kind: 'pin', image: new Uint8Array(100) }]) {
		assert.throws(() => validateScreenshotCompletion(invalid));
	}
	assert.throws(() => validateScreenshotPinRequest({ ...request, html: '<p>provider</p>' }));
});
test('native initialization cannot switch to external HTML or mix capture and pin state', () => {
	const initial = { kind: 'capture', agentWindow: true, image: image(), input: {}, locale: 'zh-CN', bundles: { ash: { title: '截图' } } };
	assert.equal(validateScreenshotInitialization(initial), initial);
	assert.equal(validateScreenshotInitialization({ ...initial, kind: 'pinned' }).kind, 'pinned');
	for (const invalid of [{ ...initial, image: new Uint8Array() }, { ...initial, agentWindow: 'true' }, { ...initial, kind: 'provider' }, { ...initial, html: 'editor' }, { ...initial, locale: '../invalid' }, { ...initial, bundles: { ash: { title: 3 } } }]) {
		assert.throws(() => validateScreenshotInitialization(invalid));
	}
});

test('desktop window previews must fit inside the frozen image', () => {
	const bounds = { x: 10, y: 20, width: 700, height: 580 };
	const initial = { kind: 'capture', agentWindow: true, image: image(), input: {}, locale: 'en', bundles: {}, windowBounds: [bounds] };
	assert.equal(validateScreenshotInitialization(initial), initial);
	assert.throws(() => validateScreenshotInitialization({ ...initial, kind: 'pinned' }));
	for (const rect of [{ ...bounds, x: -1 }, { ...bounds, x: 0.5 }, { ...bounds, width: 0 }, { ...bounds, height: 581 }, { ...bounds, title: 'Window' }]) {
		assert.throws(() => validateScreenshotInitialization({ ...initial, windowBounds: [rect] }), /Invalid screenshot window bounds/);
	}
});
