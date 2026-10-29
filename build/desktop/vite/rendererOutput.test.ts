import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import { buildMetricsPlugin } from './buildMetricsPlugin.ts';
import { rendererOutput } from './rendererOutput.ts';

test('keeps generated App Server schema modules separate from the decoder and shared renderer code', async () => {
	const decoder = 'fixture/.build/protocol/typescript/AppServerProtocolDecoder.ts';
	const schemas = [0, 1, 2].map(index => `fixture/.build/protocol/typescript/AppServerProtocolSchema${index}.ts`);
	const sharedService = 'fixture/sharedService.ts';
	const source = `import { schema } from '${decoder}';\nimport { service } from '${sharedService}';\nglobalThis.fixture = [schema, service];`;
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		plugins: [
			{
				name: 'fixture',
				resolveId(id) {
					return id === 'browser-entry' || id === 'desktop-entry' || id === decoder || id === sharedService || schemas.includes(id) ? `\0/${id}` : undefined;
				},
				load(id) {
					if (id === '\0/browser-entry' || id === '\0/desktop-entry') return source;
					if (id === `\0/${decoder}`)
						return (
							schemas.map((schema, index) => `import { definitions as definitions${index} } from '${schema}';`).join('\n') +
							'\nexport const schema = [definitions0, definitions1, definitions2];'
						);
					const index = schemas.findIndex(schema => id === `\0/${schema}`);
					if (index >= 0) return `export const definitions = ${JSON.stringify(String(index).repeat(200_000))};`;
					if (id === `\0/${sharedService}`) return `export const service = ${JSON.stringify('v'.repeat(80_000))};`;
					return undefined;
				},
			},
			buildMetricsPlugin(),
		],
		build: {
			write: false,
			rolldownOptions: { input: { browser: 'browser-entry', desktop: 'desktop-entry' }, output: rendererOutput },
		},
	});
	assert.ok(!Array.isArray(result) && 'output' in result);
	const chunks = result.output.filter(output => output.type === 'chunk');
	const protocol = chunks.find(chunk => chunk.fileName.startsWith('assets/app-server-protocol-'));
	assert.ok(protocol);
	assert.deepEqual(Object.keys(protocol.modules), [`\0/${decoder}`]);
	const schemaChunks = chunks.filter(chunk => chunk.fileName.startsWith('assets/AppServerProtocolSchema'));
	assert.equal(schemaChunks.length, schemas.length);
	assert.deepEqual(schemaChunks.flatMap(chunk => Object.keys(chunk.modules)).sort(), schemas.map(schema => `\0/${schema}`).sort());
	assert.ok(schemaChunks.every(chunk => Object.keys(chunk.modules).length === 1));
	assert.ok(chunks.every(chunk => Buffer.byteLength(chunk.code) <= 500_000));
});

test('shares each language catalog between renderers without combining languages into an oversized chunk', async () => {
	const catalogs = ['en', 'zh-CN'].map(locale => `fixture/.build/desktop/localization/localizationCatalog.${locale}.ts`);
	const index = 'fixture/.build/desktop/localization/localizationCatalogs.ts';
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		plugins: [
			{
				name: 'fixture',
				resolveId(id) {
					return ['browser-entry', 'desktop-entry', index, ...catalogs].includes(id) ? `\0/${id}` : undefined;
				},
				load(id) {
					if (id === '\0/browser-entry' || id === '\0/desktop-entry') return `import { builtinLanguagePackCatalogs } from '${index}'; globalThis.fixture = builtinLanguagePackCatalogs;`;
					if (id === `\0/${index}`)
						return catalogs.map((catalog, i) => `import { catalog as catalog${i} } from '${catalog}';`).join('\n') + '\nexport const builtinLanguagePackCatalogs = [catalog0, catalog1];';
					const i = catalogs.findIndex(catalog => id === `\0/${catalog}`);
					return i >= 0 ? `export const catalog = ${JSON.stringify(String(i).repeat(300_000))};` : undefined;
				},
			},
			buildMetricsPlugin(),
		],
		build: {
			write: false,
			rolldownOptions: { input: { browser: 'browser-entry', desktop: 'desktop-entry' }, output: rendererOutput },
		},
	});
	assert.ok(!Array.isArray(result) && 'output' in result);
	const chunks = result.output.filter(output => output.type === 'chunk');
	const languages = chunks.filter(chunk => chunk.fileName.startsWith('assets/localization-'));
	assert.equal(languages.length, 2);
	assert.deepEqual(languages.flatMap(chunk => Object.keys(chunk.modules)).sort(), catalogs.map(catalog => `\0/${catalog}`).sort());
	assert.ok(languages.every(chunk => Object.keys(chunk.modules).length === 1));
	assert.ok(chunks.every(chunk => Buffer.byteLength(chunk.code) <= 500_000));
});

test('keeps generated localization message modules separate when a single language exceeds the chunk budget', async () => {
	const parts = [0, 1, 2].map(index => `fixture/.build/desktop/localization/localizationMessages.zh-CN.${index}.ts`);
	const catalog = 'fixture/.build/desktop/localization/localizationCatalog.zh-CN.ts';
	const result = await build({
		configFile: false,
		logLevel: 'silent',
		plugins: [
			{
				name: 'fixture',
				resolveId(id) {
					return ['entry', catalog, ...parts].includes(id) ? `\0/${id}` : undefined;
				},
				load(id) {
					if (id === '\0/entry') {
						return `import { catalog } from '${catalog}'; globalThis.fixture = catalog;`;
					}
					if (id === `\0/${catalog}`) {
						return (
							parts.map((part, index) => `import { messages as messages${index} } from '${part}';`).join('\n') + '\nexport const catalog = { ...messages0, ...messages1, ...messages2 };'
						);
					}
					const index = parts.findIndex(part => id === `\0/${part}`);
					return index >= 0 ? `export const messages = { part${index}: ${JSON.stringify('译'.repeat(80_000))} };` : undefined;
				},
			},
			buildMetricsPlugin(),
		],
		build: { write: false, rolldownOptions: { input: 'entry', output: rendererOutput } },
	});
	assert.ok(!Array.isArray(result) && 'output' in result);
	const chunks = result.output.filter(output => output.type === 'chunk');
	const messages = chunks.filter(chunk => chunk.fileName.startsWith('assets/localization-messages-'));
	assert.equal(messages.length, parts.length);
	assert.ok(messages.every(chunk => Object.keys(chunk.modules).length === 1));
	assert.ok(chunks.every(chunk => Buffer.byteLength(chunk.code) < 500_000));
});
