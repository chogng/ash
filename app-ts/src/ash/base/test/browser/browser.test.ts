import assert from 'node:assert/strict';
import { test } from 'mocha';
import { getBrowserFeatures, getMonacoEnvironment } from '../../browser/browser.js';

test('getBrowserFeatures distinguishes supported browser engines and hosts', () => {
	assert.deepEqual(getBrowserFeatures('Mozilla/5.0 Firefox/141.0'), {
		isFirefox: true,
		isWebKit: false,
		isChrome: false,
		isSafari: false,
		isWebkitWebView: false,
		isElectron: false,
		isAndroid: false,
		isIOS: false,
	});
	assert.deepEqual(getBrowserFeatures('Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'), {
		isFirefox: false,
		isWebKit: true,
		isChrome: false,
		isSafari: true,
		isWebkitWebView: false,
		isElectron: false,
		isAndroid: false,
		isIOS: false,
	});
	assert.deepEqual(getBrowserFeatures('Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/138.0 Electron/37.0 Safari/537.36'), {
		isFirefox: false,
		isWebKit: true,
		isChrome: true,
		isSafari: false,
		isWebkitWebView: false,
		isElectron: true,
		isAndroid: true,
		isIOS: false,
	});
	assert.equal(getBrowserFeatures('AppleWebKit/605.1.15').isWebkitWebView, true);
	assert.equal(getBrowserFeatures({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5 }).isIOS, true);
	assert.equal(getBrowserFeatures({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5 }).isIOS, true);
	assert.equal(getBrowserFeatures({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 0 }).isIOS, false);
});

test('getMonacoEnvironment reads the current embedding environment', () => {
	const globalWithEnvironment = globalThis as typeof globalThis & { MonacoEnvironment?: { globalAPI?: boolean } };
	const previous = globalWithEnvironment.MonacoEnvironment;
	try {
		globalWithEnvironment.MonacoEnvironment = { globalAPI: true };
		assert.equal(getMonacoEnvironment()?.globalAPI, true);
	} finally {
		globalWithEnvironment.MonacoEnvironment = previous;
	}
});
