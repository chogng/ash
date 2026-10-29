import { ProcessRun } from './processes.ts';
import { resolve } from 'node:path';

/** Normalize package-manager syntax before Playwright can discard selection arguments. */
export function playwrightArguments(input: readonly string[]): string[] {
	const args = [...input];
	if (args[0] === '--') args.shift();
	if (args.includes('--')) throw new Error('Do not put -- between Playwright arguments.');
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (/^(--grep|--grep-invert|-g|-G)(=|$)/u.test(argument)) {
			const value = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[index + 1];
			if (!value?.trim() || value.startsWith('--'))
				throw new Error(`Test filter ${argument} requires a nonempty pattern.`);
		}
	}
	if (args.includes('--pass-with-no-tests')) throw new Error('Tests must fail when no tests match.');
	if (args.some(argument => /^--ui(?:$|[=-])/u.test(argument)))
		throw new Error('The runner does not support Playwright UI mode; use --debug.');
	return args;
}

/** Collection precedes asset builds and product launches, including list/help requests. */
export async function collectTests(
	run: ProcessRun,
	cli: readonly string[],
	args: readonly string[],
	environment: NodeJS.ProcessEnv,
): Promise<boolean> {
	const help = args.includes('--help') || args.includes('-h');
	const reporter =
		help || args.includes('--list') ? 'list' : resolve(import.meta.dirname, 'playwrightCollectionReporter.ts');
	const selection = await run.command(
		process.execPath,
		[...cli, '--list', `--reporter=${reporter}`],
		environment,
		true,
	);
	if (selection.code !== 0) {
		process.stdout.write(selection.output);
		process.exitCode = selection.code;
		return false;
	}
	const count = Number(selection.output.match(/Total: (\d+) tests? in /u)?.[1]);
	if (!help && !count) throw new Error(`Test collection did not select any tests.\n${selection.output}`);
	if (help || args.includes('--list')) {
		process.stdout.write(selection.output);
		return false;
	}
	console.log(`Test selection: ${count} tests.`);
	return true;
}
