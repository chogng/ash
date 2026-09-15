import type { Rolldown } from 'vite';

export const rendererOutput: Rolldown.OutputOptions = {
	// Contributions register through module side effects; splitting must retain import execution order.
	strictExecutionOrder: true,
	codeSplitting: {
		groups: [{
			name: 'shared',
			test: () => true,
			entriesAware: true,
			// Rolldown measures modules before minification. Current builds yield chunks below 500 kB.
			maxSize: 800_000,
		}],
	},
};
