import type { Rolldown } from 'vite';

export const rendererOutput: Rolldown.OutputOptions = {
	// Contributions register through module side effects; splitting must retain import execution order.
	strictExecutionOrder: true,
	codeSplitting: {
		groups: [{
			name: id => `localization-${id.replaceAll('\\', '/').split('/').at(-1)!.slice('localizationCatalog.'.length, -3)}`,
			// Languages grow independently; keep each catalog separate from Workbench code and other languages.
			test: id => /\/\.build\/desktop\/localization\/localizationCatalog\.[^/]+\.ts$/u.test(id.replaceAll('\\', '/')),
		}, {
			name: 'app-server-protocol',
			// The generated validator is shared by both renderers and nearly fills one output chunk.
			test: id => id.replaceAll('\\', '/').endsWith('/app-server-protocol/schema/typescript/AppServerProtocolDecoder.ts'),
		}, {
			name: 'shared',
			test: () => true,
			entriesAware: true,
			// Rolldown splits before minification; buildMetricsPlugin checks final emitted bytes.
			maxSize: 800_000,
		}],
	},
};
