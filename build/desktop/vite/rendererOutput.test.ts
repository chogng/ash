import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';
import { rendererOutput } from './rendererOutput.ts';

test('keeps the generated App Server decoder separate from shared renderer code', async () => {
	const decoder = 'fixture/.build/protocol/typescript/AppServerProtocolDecoder.ts';
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

test('shares each language catalog between renderers without combining languages into an oversized chunk', async () => {
	const catalogs = ['en', 'zh-CN'].map(locale => `fixture/.build/desktop/localization/localizationCatalog.${locale}.ts`);
	const index = 'fixture/.build/desktop/localization/localizationCatalogs.ts';
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		plugins: [{
			name: 'fixture',
			resolveId(id) { return ['browser-entry', 'desktop-entry', index, ...catalogs].includes(id) ? `\0/${id}` : undefined; },
			load(id) {
				if (id === '\0/browser-entry' || id === '\0/desktop-entry') return `import { builtinLanguagePackCatalogs } from '${index}'; globalThis.fixture = builtinLanguagePackCatalogs;`;
				if (id === `\0/${index}`) return catalogs.map((catalog, i) => `import { catalog as catalog${i} } from '${catalog}';`).join('\n') + '\nexport const builtinLanguagePackCatalogs = [catalog0, catalog1];';
				const i = catalogs.findIndex(catalog => id === `\0/${catalog}`);
				return i >= 0 ? `export const catalog = ${JSON.stringify(String(i).repeat(300_000))};` : undefined;
			},
		}, buildMetricsPlugin()],
		build: { write: false, rolldownOptions: { input: { browser: 'browser-entry', desktop: 'desktop-entry' }, output: rendererOutput } },
	});
	assert.ok(!Array.isArray(result) && 'output' in result);
	const chunks = result.output.filter(output => output.type === 'chunk');
	const languages = chunks.filter(chunk => chunk.fileName.startsWith('assets/localization-'));
	assert.equal(languages.length, 2);
	assert.deepEqual(languages.flatMap(chunk => Object.keys(chunk.modules)).sort(), catalogs.map(catalog => `\0/${catalog}`).sort());
	assert.ok(languages.every(chunk => Object.keys(chunk.modules).length === 1));
	assert.ok(chunks.every(chunk => Buffer.byteLength(chunk.code) <= 500_000));
});
