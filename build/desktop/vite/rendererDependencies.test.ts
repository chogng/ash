import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';
import { rendererDependencyAliases } from './rendererDependencies.ts';
import { rendererOutput } from './rendererOutput.ts';

test('keeps the real LiveKit media dependency lazy and within renderer chunk limits', async () => {
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		resolve: { alias: rendererDependencyAliases },
		plugins: [
			{
				name: 'voice-fixture',
				resolveId: id => (id === 'voice-entry' ? '\0voice-entry' : undefined),
				load: id =>
					id === '\0voice-entry'
						? 'globalThis.startVoice = () => import("livekit-client").then(({ Room, ExternalE2EEKeyProvider }) => [Room, ExternalE2EEKeyProvider]);'
						: undefined,
			},
			buildMetricsPlugin(),
		],
		build: { write: false, rolldownOptions: { input: 'voice-entry', output: rendererOutput } },
	});
	assert.ok(!Array.isArray(result) && 'output' in result);
	const chunks = result.output.filter(output => output.type === 'chunk');
	assert.ok(
		chunks.some(chunk =>
			Object.keys(chunk.modules).some(id =>
				id.replaceAll('\\', '/').endsWith('/livekit-client/src/room/Room.ts'),
			),
		),
	);
	assert.ok(chunks.every(chunk => Buffer.byteLength(chunk.code) <= 500_000));
	const entry = chunks.find(chunk => chunk.isEntry)!;
	assert.ok(entry.dynamicImports.length > 0);
	assert.ok(!Object.keys(entry.modules).some(id => id.includes('/livekit-client/')));
});
