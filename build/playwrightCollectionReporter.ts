import type { FullConfig, Reporter, Suite } from '@playwright/test/reporter';

/** A bounded summary keeps large test collections from losing their count in CLI stdout. */
export default class PlaywrightCollectionReporter implements Reporter {
	onBegin(_config: FullConfig, suite: Suite): void {
		const tests = suite.allTests();
		const files = new Set(tests.map(test => test.location.file));
		console.log(`Total: ${tests.length} tests in ${files.size} files`);
	}
}
