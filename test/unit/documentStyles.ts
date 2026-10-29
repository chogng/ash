import assert from 'node:assert/strict';
import { setup, teardown } from 'mocha';
import { captureDocumentStyles, compareDocumentStyles } from '../fixtures/documentStyles.js';

/** Check each test without removing leaked nodes and hiding the owner of the leak. */
export function ensureNoStylesAreLeakedInTestSuite(): void {
	let before: ReturnType<typeof captureDocumentStyles> | undefined;
	setup(() => {
		before = captureDocumentStyles(document.documentElement);
	});
	teardown(async () => {
		if (!before) return;
		const baseline = before;
		before = undefined;
		// Let settled render promises finish after synchronous resource disposal.
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(compareDocumentStyles(baseline, captureDocumentStyles(document.documentElement)), [], 'Test must restore shared document styles');
	});
}
