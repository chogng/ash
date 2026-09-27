import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';
import { rendererOutput } from './rendererOutput.ts';

test('keeps the generated App Server decoder separate from shared renderer code', async () => {
	const decoder = 'fixture/generated/AppServerProtocolDecoder.ts';
	const sharedService = 'fixture/sharedService.ts';
	const source = `import { schema } from '${decoder}';\nimport { service } from '${sharedService}';\nglobalThis.fixture = [schema, service];`;
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		plugins: [{
			name: 'fixture',
			resolveId(id) { return id === 'browser-entry' || id === 'desktop-entry' || id === decoder || id === sharedService ? `\0/${id}` : undefined; },
			load(id) {
				if (id === '\0/browser-entry' || id === '\0/desktop-entry') return source;
				if (id === `\0/${decoder}`) return `export const schema = ${JSON.stringify('s'.repeat(460_000))};`;
				if (id === `\0/${sharedService}`) return `export const service = ${JSON.stringify('v'.repeat(80_000))};`;
				return undefined;
			},
		}, buildMetricsPlugin()],
		build: { write: false, rolldownOptions: { input: { browser: 'browser-entry', desktop: 'desktop-entry' }, output: rendererOutput } },
	});
	assert.ok(!Array.isArray(result) && 'output' in result);
	const chunks = result.output.filter(output => output.type === 'chunk');
	const protocol = chunks.find(chunk => chunk.fileName.startsWith('assets/app-server-protocol-'));
	assert.ok(protocol);
	assert.deepEqual(Object.keys(protocol.modules), [`\0/${decoder}`]);
	assert.ok(chunks.every(chunk => Buffer.byteLength(chunk.code) <= 500_000));
});
