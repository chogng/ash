/** Scans component fixtures and writes CSS order findings and source evidence. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withProcessRun } from '../../build/processes.ts';
import { createResultsDirectory, parseFixtureArguments, Renderer, writeScanReport } from './cssOrderShared.mts';

async function main(): Promise<void> {
	if (process.argv.includes('--help')) {
		console.log(
			'Usage: node test/componentFixtures/cssOrderScan.mts [--config <path>] [--fixture-id-regex <regex>] [--stylesheet-source-regex <regex>] [--out <dir>] [--time-budget-minutes <n>] [--batch-size <n>] [--concurrency <1-8>]',
		);
		return;
	}
	const request = parseFixtureArguments(process.argv.slice(2));
	if (
		request.explore ||
		request.screenshots ||
		request.compare ||
		request.baselineRef ||
		request.playwrightArgs.length
	)
		throw new Error(`Unexpected scan arguments: ${request.playwrightArgs.join(' ')}`);
	const directory = await createResultsDirectory('css-order-scan', request.out);
	await withProcessRun(resolve(import.meta.dirname, '../..'), async (run, environment) => {
		const renderer = new Renderer(request.config, directory);
		try {
			await renderer.start(run, environment);
			const fixtures = await renderer.fixtures(request.options.pattern);
			const report = await renderer.scan(fixtures, request.options);
			await writeScanReport(directory, report);
			if (report.results.some(result => result.status === 'error')) process.exitCode = 1;
		} finally {
			await renderer.dispose();
		}
	});
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	await main().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
}
