import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';
import { rendererOutput } from './rendererOutput.ts';

test('splits shared renderer modules below the emitted JavaScript limit', async () => {
	const parts = Array.from({ length: 6 }, (_, index) => `part-${index}`);
	const source = parts.map((part, index) => `import part${index} from '${part}';`).join('\n')
		+ `\nglobalThis.fixture = [${parts.map((_, index) => `part${index}`).join(', ')}];`;
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		plugins: [{
			name: 'fixture',
			resolveId(id) { return id === 'browser-entry' || id === 'desktop-entry' || parts.includes(id) ? `\0${id}` : undefined; },
			load(id) {
				if (id === '\0browser-entry' || id === '\0desktop-entry') return source;
				const index = parts.indexOf(id.slice(1));
				return index < 0 ? undefined : `export default ${JSON.stringify(String(index).repeat(120_000))};`;
			},
		}, buildMetricsPlugin()],
		build: { write: false, rolldownOptions: { input: { browser: 'browser-entry', desktop: 'desktop-entry' }, output: rendererOutput } },
	});
	assert.ok(!Array.isArray(result) && 'output' in result);
	const chunks = result.output.filter(output => output.type === 'chunk');
	assert.ok(chunks.length > 2);
	assert.ok(chunks.every(chunk => Buffer.byteLength(chunk.code) <= 500_000));
});
