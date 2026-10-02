import { setup, teardown } from 'mocha';
import { DisposableTracker, installDisposableTracker } from '../../common/lifecycle.js';

/** Checks resources created during each test without changing their ownership. */
export function ensureNoDisposablesAreLeakedInTestSuite(): void {
	let tracker: DisposableTracker;
	let installation: globalThis.Disposable;
	setup(() => {
		tracker = new DisposableTracker();
		installation = installDisposableTracker(tracker);
	});
	teardown(() => {
		installation[Symbol.dispose]();
		tracker.assertNoLeaks();
	});
}
