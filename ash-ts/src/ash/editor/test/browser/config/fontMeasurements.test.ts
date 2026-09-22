import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { FontMeasurementsImpl } from '../../../browser/config/fontMeasurements.js';
import { createBareFontInfoFromRawSettings } from '../../../common/config/fontInfoFromSettings.js';
import { DisposableTracker, installDisposableTracker } from '../../../../base/common/lifecycle.js';

test('FontMeasurements expires unreliable readings independently in every window', async function () {
	this.timeout(10_000);
	const first = new JSDOM('<body></body>');
	const second = new JSDOM('<body></body>');
	const closed = new JSDOM('<body></body>');
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
		await new Promise(resolve => setTimeout(resolve, 5_100));
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
