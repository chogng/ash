import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { FontMeasurementsImpl, type ISerializedFontInfo } from '../../../browser/config/fontMeasurements.js';
import { createBareFontInfoFromRawSettings } from '../../../common/config/fontInfoFromSettings.js';
import { FontInfo } from '../../../common/config/fontInfo.js';
import { DisposableTracker, installDisposableTracker, toDisposable } from '../../../../base/common/lifecycle.js';

function savedFontInfo(): ISerializedFontInfo {
	return new FontInfo({
		...createBareFontInfoFromRawSettings({ fontSize: 14 }, 1, true),
		isMonospace: true,
		typicalHalfwidthCharacterWidth: 8,
		typicalFullwidthCharacterWidth: 16,
		canUseHalfwidthRightwardsArrow: true,
		spaceWidth: 8,
		middotWidth: 8,
		wsmiddotWidth: 8,
		maxDigitWidth: 8,
	}, true);
}

test('restored font metrics preserve persisted values until the window measures again', () => {
	const dom = new JSDOM('<body></body>');
	using cleanup = toDisposable(() => dom.window.close());
	using evictionTimers = installWindowTimeouts(dom);
	using measurements = new FontMeasurementsImpl();
	const target = dom.window as unknown as Window;
	const saved = savedFontInfo();
	const font = new FontInfo(saved, false);
	assert.deepEqual(measurements.serializeFontInfo(target), []);
	measurements.restoreFontInfo(target, JSON.parse(JSON.stringify([saved])));
	const restored = measurements.readFontInfo(target, font);
	assert.equal(restored.isTrusted, false);
	assert.equal(restored.typicalHalfwidthCharacterWidth, saved.typicalHalfwidthCharacterWidth);
	assert.equal(measurements.serializeFontInfo(target), undefined);
	evictionTimers.runPending();
	assert.equal(measurements.serializeFontInfo(target), undefined);
	Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', { get: () => 2048 });
	const measured = measurements.readFontInfo(target, font);
	assert.notStrictEqual(measured, restored);
	assert.equal(measured.isTrusted, true);
	assert.deepEqual(measurements.serializeFontInfo(target), [measured]);
	measurements.clearAllFontInfos();
	assert.deepEqual(measurements.serializeFontInfo(target), []);
});

test('restored font validation rejects stale versions and malformed metrics without poisoning the cache', () => {
	const dom = new JSDOM('<body></body>');
	using cleanup = toDisposable(() => dom.window.close());
	using measurements = new FontMeasurementsImpl();
	const target = dom.window as unknown as Window;
	const saved = savedFontInfo();
	const invalid = [
		null, {}, { ...saved, version: saved.version - 1 },
		{ ...saved, fontFamily: 5 }, { ...saved, isMonospace: 'true' },
		{ ...saved, pixelRatio: 0 }, { ...saved, fontSize: -1 },
		{ ...saved, typicalHalfwidthCharacterWidth: null }, { ...saved, spaceWidth: 0 },
		{ ...saved, letterSpacing: '1' }, { ...saved, middotWidth: -1 },
	];
	measurements.restoreFontInfo(target, JSON.parse(JSON.stringify(invalid)));
	assert.deepEqual(measurements.serializeFontInfo(target), []);
	measurements.restoreFontInfo(target, JSON.parse(JSON.stringify([...invalid, saved])));
	assert.equal(measurements.readFontInfo(target, new FontInfo(saved, false)).typicalHalfwidthCharacterWidth, 8);
	assert.equal(measurements.serializeFontInfo(target), undefined);
});

test('failed fresh font measurements do not preserve another window\'s restored state', () => {
	const first = new JSDOM('<body></body>');
	const second = new JSDOM('<body></body>');
	using cleanup = toDisposable(() => { first.window.close(); second.window.close(); });
	using measurements = new FontMeasurementsImpl();
	const target = first.window as unknown as Window;
	measurements.restoreFontInfo(target, [savedFontInfo()]);
	const freshFont = createBareFontInfoFromRawSettings({ fontSize: 18 }, 1, true);
	measurements.readFontInfo(second.window as unknown as Window, freshFont);
	assert.deepEqual(measurements.serializeFontInfo(second.window as unknown as Window), []);
	assert.equal(measurements.serializeFontInfo(target), undefined);
	measurements.readFontInfo(target, freshFont);
	assert.deepEqual(measurements.serializeFontInfo(target), []);
});

test('FontMeasurements expires unreliable readings independently in every window', () => {
	const first = new JSDOM('<body></body>');
	const second = new JSDOM('<body></body>');
	const closed = new JSDOM('<body></body>');
	using firstTimers = installWindowTimeouts(first);
	using secondTimers = installWindowTimeouts(second);
	const tracker = new DisposableTracker();
	using tracking = installDisposableTracker(tracker);
	using measurements = new FontMeasurementsImpl();
	const font = createBareFontInfoFromRawSettings({ fontSize: 14 }, 1, true);
	const windows = [first, second].map(dom => dom.window as unknown as Window);
	let changes = 0;
	using listener = measurements.onDidChange(() => changes++);
	try {
		const before = windows.map(target => measurements.readFontInfo(target, font));
		measurements.readFontInfo(closed.window as unknown as Window, font);
		closed.window.dispatchEvent(new closed.window.PageTransitionEvent('pagehide'));
		closed.window.close();
		firstTimers.runPending();
		secondTimers.runPending();
		const after = windows.map(target => measurements.readFontInfo(target, font));
		assert.deepEqual({
			expired: after.map((value, index) => value !== before[index]),
			trusted: after.map(value => value.isTrusted),
			changes,
		}, { expired: [true, true], trusted: [false, false], changes: 2 });
	} finally {
		measurements.clearAllFontInfos();
		listener.dispose();
		measurements.dispose();
		first.window.dispatchEvent(new first.window.PageTransitionEvent('pagehide'));
		second.window.dispatchEvent(new second.window.PageTransitionEvent('pagehide'));
		first.window.close();
		second.window.close();
		closed.window.close();
	}
	tracker.assertNoLeaks();
});

/** Runs the window-owned expiry callbacks without waiting for the five-second cache lifetime. */
function installWindowTimeouts(dom: JSDOM): { runPending(): void; [Symbol.dispose](): void } {
	const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(dom.window, 'setTimeout');
	const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(dom.window, 'clearTimeout');
	assert.ok(setTimeoutDescriptor);
	assert.ok(clearTimeoutDescriptor);
	const callbacks = new Map<number, () => void>();
	let nextHandle = 0;
	Object.defineProperty(dom.window, 'setTimeout', {
		configurable: true,
		value: (callback: () => void, delay: number) => {
			assert.equal(delay, 5_000);
			const handle = ++nextHandle;
			callbacks.set(handle, callback);
			return handle;
		},
	});
	Object.defineProperty(dom.window, 'clearTimeout', {
		configurable: true,
		value: (handle: number) => callbacks.delete(handle),
	});
	return {
		runPending(): void {
			const pending = [...callbacks.values()];
			callbacks.clear();
			for (const callback of pending) callback();
		},
		[Symbol.dispose](): void {
			Object.defineProperty(dom.window, 'setTimeout', setTimeoutDescriptor);
			Object.defineProperty(dom.window, 'clearTimeout', clearTimeoutDescriptor);
		},
	};
}
