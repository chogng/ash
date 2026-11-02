import assert from 'node:assert/strict';
import { suite, suiteSetup, suiteTeardown, setup, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IMAGE_VIEW_CANCEL_CHANNEL, IMAGE_VIEW_OPEN_CHANNEL, type ImageViewRequest } from '../../../../../platform/imageView/common/imageView.js';

suite('Native image editor request lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
	let environment: JSDOM;
	let Service: typeof import('../../electron-browser/nativeImageEditorService.js').NativeImageEditorService;
	const opened: ImageViewRequest[] = [];
	const cancelled: string[] = [];
	let output: DeferredPromise<Uint8Array | undefined> | undefined;
	let windowOpened: DeferredPromise<void>;

	suiteSetup(async () => {
		environment = new JSDOM('<!doctype html><html><body></body></html>');
		Object.defineProperty(globalThis, 'document', { configurable: true, value: environment.window.document });
		Object.defineProperty(globalThis, 'ash', {
			configurable: true, value: {
				ipcRenderer: {
					invoke: async (channel: string, request: ImageViewRequest | string) => {
						if (channel === IMAGE_VIEW_OPEN_CHANNEL) {
							opened.push(request as ImageViewRequest);
							void windowOpened.complete();
							return output?.p;
						}
						assert.equal(channel, IMAGE_VIEW_CANCEL_CHANNEL);
						cancelled.push(request as string);
						await output?.complete(undefined);
						return undefined;
					}
				}
			}
		});
		Service = (await import('../../electron-browser/nativeImageEditorService.js')).NativeImageEditorService;
	});

	suiteTeardown(() => {
		if (previous) Object.defineProperty(globalThis, 'ash', previous);
		else Reflect.deleteProperty(globalThis, 'ash');
		if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
		else Reflect.deleteProperty(globalThis, 'document');
		environment.window.close();
	});

	setup(() => { opened.length = 0; cancelled.length = 0; output = undefined; windowOpened = new DeferredPromise(); });

	test('a superseded provider resolution cannot open a late native window', async () => {
		using service = new Service();
		const first = new DeferredPromise<{ html: string; }>();
		let resolutions = 0;
		using provider = service.register({
			id: 'test.image', displayName: 'Image', default: true, accessibilityHelp: '',
			signal: new AbortController().signal,
			resolve: async () => ++resolutions === 1 ? first.p : { html: 'newer' },
		});
		const older = service.capture(new AbortController().signal);
		// Observe rejection immediately, before the replacement aborts this request.
		const olderResult = assert.rejects(older, { name: 'AbortError' });
		await service.capture(new AbortController().signal);
		await first.complete({ html: 'older' });
		await olderResult;
		assert.deepEqual(opened.map(request => request.html), ['newer']);
	});

	test('disposing during provider resolution prevents a native window from opening', async () => {
		using service = new Service();
		const view = new DeferredPromise<{ html: string; }>();
		using provider = service.register({
			id: 'test.image', displayName: 'Image', default: true, accessibilityHelp: '',
			signal: new AbortController().signal, resolve: () => view.p,
		});
		const result = assert.rejects(service.capture(new AbortController().signal), { name: 'AbortError' });
		service.dispose();
		await view.complete({ html: 'late' });
		await result;
		assert.deepEqual(opened, []);
	});

	test('replacing a request aborts its provider work before the replacement resolves', async () => {
		using service = new Service();
		const view = new DeferredPromise<{ html: string; }>();
		const signals: AbortSignal[] = [];
		using provider = service.register({
			id: 'test.image', displayName: 'Image', default: true, accessibilityHelp: '',
			signal: new AbortController().signal,
			resolve: (_source, signal) => { signals.push(signal); return view.p; },
		});
		const first = assert.rejects(service.capture(new AbortController().signal), { name: 'AbortError' });
		const second = service.capture(new AbortController().signal);
		const aborted = signals[0].aborted;
		await view.complete({ html: 'editor' });
		await Promise.all([first, second]);
		assert.equal(aborted, true);
		assert.equal(opened.length, 1);
	});

	test('cancelling an open native request uses its exact request ID and discards output', async () => {
		using service = new Service();
		using provider = service.register({
			id: 'test.image', displayName: 'Image', default: true, accessibilityHelp: '',
			signal: new AbortController().signal,
			resolve: async () => ({ html: 'editor' }),
		});
		output = new DeferredPromise();
		const controller = new AbortController();
		const result = service.capture(controller.signal);
		await windowOpened.p;
		assert.equal(opened.length, 1);
		controller.abort();
		assert.equal(await result, undefined);
		assert.deepEqual(cancelled, [opened[0].id]);
	});

	test('starting a replacement closes the active window while its provider is still resolving', async () => {
		using service = new Service();
		const next = new DeferredPromise<{ html: string; }>();
		let resolutions = 0;
		using provider = service.register({
			id: 'test.image', displayName: 'Image', default: true, accessibilityHelp: '',
			signal: new AbortController().signal,
			resolve: async () => ++resolutions === 1 ? { html: 'first' } : next.p,
		});
		output = new DeferredPromise();
		const first = service.capture(new AbortController().signal);
		await windowOpened.p;
		const second = service.capture(new AbortController().signal);
		assert.deepEqual(cancelled, [opened[0].id]);
		assert.equal(await first, undefined);
		output = undefined;
		await next.complete({ html: 'second' });
		await second;
		assert.deepEqual(opened.map(request => request.html), ['first', 'second']);
	});

	test('completed image output is preserved without a redundant cancellation IPC', async () => {
		using service = new Service();
		using provider = service.register({
			id: 'test.image', displayName: 'Image', default: true, accessibilityHelp: '',
			signal: new AbortController().signal, resolve: async () => ({ html: 'editor' }),
		});
		const image = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4AAAAABJRU5ErkJggg==', 'base64'));
		output = new DeferredPromise();
		const result = service.capture(new AbortController().signal);
		await windowOpened.p;
		assert.equal(opened[0].source, 'screen', 'Manual capture must request desktop selection');
		await output.complete(image);
		assert.deepEqual((await result)?.buffer, image);
		assert.deepEqual(cancelled, []);
	});
});
