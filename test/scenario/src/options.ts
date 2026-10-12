export interface RunnerOptions {
	readonly web: boolean;
	readonly headless: boolean;
	readonly activeWindow: boolean;
	readonly verbose: boolean;
	readonly dev: boolean;
}

export function parseRunnerOptions(arguments_: readonly string[]): RunnerOptions {
	const known = new Set(['--', '--web', '--headless', '--verbose', '--dev', '--active-window']);
	for (const argument of arguments_.filter(value => value.startsWith('--'))) {
		if (!known.has(argument)) {
			throw new Error(`Unknown option: ${argument}`);
		}
	}
	if (arguments_.includes('--web') && arguments_.includes('--active-window')) {
		throw new Error('--active-window requires a Desktop scenario');
	}
	return {
		web: arguments_.includes('--web'),
		headless: arguments_.includes('--headless'),
		activeWindow: arguments_.includes('--active-window'),
		verbose: arguments_.includes('--verbose'),
		dev: arguments_.includes('--dev'),
	};
}
