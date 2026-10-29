/** Localizes a CSS order conflict for one explicitly selected component fixture. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withProcessRun } from '../../build/processes.ts';
import { createResultsDirectory, parseFixtureArguments, Renderer, writeScanReport } from './cssOrderShared.mts';

async function main(): Promise<void> {
	if (process.argv.includes('--help')) {
		console.log(
			'Usage: node test/componentFixtures/cssOrderBisect.mts --fixture-id-regex <exactly-one-fixture> [--config <path>] [--out <dir>] [--time-budget-minutes <n>] [--stylesheet-source-regex <regex>] [--concurrency <1-8>] [--batch-size <n>]',
		);
		return;
	}
	const args = process.argv.slice(2);
	const request = parseFixtureArguments(args);
	if (!args.includes('--fixture-id-regex'))
		throw new Error('Bisection requires --fixture-id-regex matching exactly one fixture');
	if (
		request.explore ||
		request.screenshots ||
		request.compare ||
		request.baselineRef ||
		request.playwrightArgs.length
	)
		throw new Error(`Unexpected bisection arguments: ${request.playwrightArgs.join(' ')}`);
	const directory = await createResultsDirectory('css-order-bisect', request.out);
	await withProcessRun(resolve(import.meta.dirname, '../..'), async (run, environment) => {
		const renderer = new Renderer(request.config, directory);
		try {
			await renderer.start(run, environment);
			const fixtures = await renderer.fixtures(request.options.pattern);
			if (fixtures.length !== 1)
				throw new Error(`Bisection requires exactly one fixture; matched ${fixtures.length}`);
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
