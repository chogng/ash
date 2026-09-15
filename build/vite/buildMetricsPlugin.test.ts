import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';

function buildFixture(source: string) {
	return build({
		configFile: false,
		logLevel: 'silent',
		plugins: [{
			name: 'fixture',
			resolveId(id) { return id === 'fixture' ? '\0fixture' : undefined; },
			load(id) { return id === '\0fixture' ? source : undefined; },
		}, buildMetricsPlugin()],
		build: { write: false, rolldownOptions: { input: 'fixture' } },
	});
}

test('reports final emitted JavaScript bytes', async () => {
	const result = await buildFixture('globalThis.fixture = "hello";');
	assert.ok(!Array.isArray(result) && 'output' in result);
	const report = result.output.find(output => output.fileName === 'build-metrics.json');
	assert.ok(report?.type === 'asset');
	const entries = JSON.parse(String(report.source));
	const chunks = result.output.filter(output => output.type === 'chunk');
	assert.equal(entries[0].staticJavaScriptBytes, chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.code), 0));
});

test('fails a build when a JavaScript chunk exceeds the size limit', async () => {
	await assert.rejects(buildFixture(`globalThis.fixture = ${JSON.stringify('x'.repeat(500_001))};`), /JavaScript chunk exceeds 500 kB/);
});
