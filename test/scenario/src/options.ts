export interface RunnerOptions {
	readonly web: boolean;
	readonly headless: boolean;
	readonly verbose: boolean;
	readonly dev: boolean;
}

export function parseRunnerOptions(arguments_: readonly string[]): RunnerOptions {
	const known = new Set(['--', '--web', '--headless', '--verbose', '--dev']);
	for (const argument of arguments_.filter(value => value.startsWith('--'))) {
		if (!known.has(argument)) {
			throw new Error(`Unknown option: ${argument}`);
		}
	}
	return {
		web: arguments_.includes('--web'),
		headless: arguments_.includes('--headless'),
		verbose: arguments_.includes('--verbose'),
		dev: arguments_.includes('--dev'),
	};
}
