import type { Rolldown } from 'vite';

export const rendererOutput: Rolldown.OutputOptions = {
	// Contributions register through module side effects; splitting must retain import execution order.
	strictExecutionOrder: true,
	codeSplitting: {
		groups: [{
			name: 'app-server-protocol',
			// The generated validator is shared by both renderers and nearly fills one output chunk.
			test: id => id.replaceAll('\\', '/').endsWith('/generated/AppServerProtocolDecoder.ts'),
		}, {
			name: 'shared',
			test: () => true,
			entriesAware: true,
			// Rolldown splits before minification; buildMetricsPlugin checks final emitted bytes.
			maxSize: 800_000,
		}],
	},
};
