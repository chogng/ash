import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setup, suite, suiteSetup, suiteTeardown, teardown, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import type { IMainProcessService } from '../../../ipc/common/mainProcessService.js';
import type { INativeHostApi } from '../../common/nativeHost.js';

suite('Native app window stream lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const previous = new Map(['ash', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
	const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4AAAAABJRU5ErkJggg==', 'base64'));
	const window = { sourceId: 'window:42:0', title: 'Synthetic app' };
	let host: INativeHostApi;
	let native: () => Promise<unknown>;
	let acquired: DeferredPromise<MediaStream>;
	let acquiring: DeferredPromise<void>;
	let playing: DeferredPromise<void>;
	let playGate: Promise<void> | undefined;
	let frameReady: DeferredPromise<void>;
	let frame: (() => void) | undefined;
	let stopped: number;
	let paused: number;
	let cancelledFrames: number;
	let draws: number;
	let stream: MediaStream;
	let tracksStopped: DeferredPromise<void>;
	let video: { muted: boolean; srcObject: MediaStream | null; };

	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'ash', {
			configurable: true, value: {
				ipcRenderer: {
					invoke: async (channel: string, value: unknown) => {
						assert.equal(channel, 'ash:native-host:capture-app-window');
						assert.deepEqual(value, window);
						return native();
					}
				},
			}
		});
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true, value: {
				mediaDevices: {
					getUserMedia: async (constraints: unknown) => {
						assert.deepEqual(constraints, { audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: window.sourceId, maxWidth: 8192, maxHeight: 8192 } } });
						void acquiring.complete();
						return acquired.p;
					}
				},
			}
		});
		Object.defineProperty(globalThis, 'document', {
			configurable: true, value: {
				createElement: (tag: string) => {
					if (tag === 'video') return video;
					assert.equal(tag, 'canvas');
					return {
						getContext: () => ({ drawImage: () => { draws++; } }),
						toBlob: (callback: (blob: Blob) => void) => callback(new Blob([png])),
					};
				},
			}
		});
		const { createNativeHostApi } = await import('../../electron-browser/nativeHostApi.js');
		host = createNativeHostApi({ getChannel: () => ({}) } as unknown as IMainProcessService);
	});
	suiteTeardown(() => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	setup(() => {
		native = async () => undefined;
		acquired = new DeferredPromise(); acquiring = new DeferredPromise(); playing = new DeferredPromise(); frameReady = new DeferredPromise();
		playGate = undefined; frame = undefined;
		stopped = 0; paused = 0; cancelledFrames = 0; draws = 0;
		tracksStopped = new DeferredPromise();
		stream = { getTracks: () => [{ stop: () => { stopped++; void tracksStopped.complete(); } }] } as unknown as MediaStream;
		video = {
			muted: false, srcObject: null, videoWidth: 1, videoHeight: 1,
			play: async () => { void playing.complete(); await playGate; },
			pause: () => { paused++; },
			requestVideoFrameCallback: (callback: () => void) => { frame = callback; void frameReady.complete(); return 1; },
			cancelVideoFrameCallback: (id: number) => { assert.equal(id, 1); cancelledFrames++; frame = undefined; },
		} as typeof video;
	});
	teardown(() => mock.timers.reset());

	test('cancelling a native request prevents a late renderer fallback', async () => {
		const reply = new DeferredPromise<unknown>();
		native = () => reply.p;
		const controller = new AbortController();
		const result = host.captureAppWindow(window, controller.signal);
		const rejected = assert.rejects(result, isCancellationError);
		controller.abort();
		await rejected;
		await reply.complete(undefined);
		assert.equal(acquiring.isSettled, false);
	});
	test('cancelling before media acquisition stops every late track without playing it', async () => {
		const controller = new AbortController();
		const result = host.captureAppWindow(window, controller.signal);
		const rejected = assert.rejects(result, isCancellationError);
		await acquiring.p;
		controller.abort();
		await rejected;
		await acquired.complete(stream);
		await tracksStopped.p;
		assert.equal(stopped, 1);
		assert.equal(playing.isSettled, false);
		assert.equal(video.srcObject, null);
	});
	test('cancelling while video play is pending stops the stream and never registers a late frame', async () => {
		const play = new DeferredPromise<void>();
		playGate = play.p;
		const controller = new AbortController();
		const result = host.captureAppWindow(window, controller.signal);
		const rejected = assert.rejects(result, isCancellationError);
		await acquiring.p;
		await acquired.complete(stream);
		await playing.p;
		controller.abort();
		await rejected;
		await play.complete();
		assert.equal(stopped, 1);
		assert.equal(frameReady.isSettled, false);
		assert.equal(video.srcObject, null);
	});
	test('cancelling a pending frame immediately releases the stream and callback', async () => {
		const controller = new AbortController();
		const result = host.captureAppWindow(window, controller.signal);
		const rejected = assert.rejects(result, isCancellationError);
		await acquiring.p;
		await acquired.complete(stream);
		await frameReady.p;
		controller.abort();
		await rejected;
		assert.deepEqual({ stopped, paused, cancelledFrames, draws, source: video.srcObject }, { stopped: 1, paused: 1, cancelledFrames: 1, draws: 0, source: null });
	});
	test('one successful frame returns PNG pixels and retires cancellation and capture resources', async () => {
		const controller = new AbortController();
		const result = host.captureAppWindow(window, controller.signal);
		await acquiring.p;
		await acquired.complete(stream);
		await frameReady.p;
		frame!();
		assert.deepEqual((await result)?.buffer, png);
		controller.abort();
		assert.deepEqual({ stopped, paused, cancelledFrames, draws, source: video.srcObject }, { stopped: 1, paused: 1, cancelledFrames: 0, draws: 1, source: null });
	});
	test('a frame timeout releases the same resources as cancellation', async () => {
		mock.timers.enable({ apis: ['setTimeout'] });
		const result = host.captureAppWindow(window);
		const rejected = assert.rejects(result, /Application window capture timed out/);
		await acquiring.p;
		await acquired.complete(stream);
		await frameReady.p;
		mock.timers.tick(5000);
		await rejected;
		assert.deepEqual({ stopped, paused, cancelledFrames, draws, source: video.srcObject }, { stopped: 1, paused: 1, cancelledFrames: 1, draws: 0, source: null });
	});
});
