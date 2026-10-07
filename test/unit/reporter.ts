import { writeFileSync } from 'node:fs';
import { reporters, type MochaOptions, type Runner } from 'mocha';

/** Retains Mocha's readable output while reporting executed counts across isolated files. */
export default class UnitTestReporter extends reporters.Spec {
	constructor(runner: Runner, options: MochaOptions) {
		super(runner, options);
		runner.once('end', () => {
			writeFileSync(options.reporterOptions.countFile, String(runner.stats!.tests - runner.stats!.pending));
		});
	}
}
