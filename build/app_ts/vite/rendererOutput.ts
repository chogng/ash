import type { Rolldown } from 'vite';

export const rendererOutput: Rolldown.OutputOptions = {
	// Contributions register through module side effects; splitting must retain import execution order.
	strictExecutionOrder: true,
	codeSplitting: {
		groups: [{
			name: 'shared',
			test: () => true,
			entriesAware: true,
			// Rolldown splits before minification; buildMetricsPlugin checks final emitted bytes.
			maxSize: 500_000,
		}],
	},
};
