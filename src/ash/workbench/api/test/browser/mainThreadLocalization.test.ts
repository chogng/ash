import assert from 'node:assert/strict';
import { suite, teardown, test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { extensionResourceRequest } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { createEmptyTestLanguagePacks } from '../../../services/localization/test/common/localizationTestUtils.js';
import { MainThreadLocalization } from '../../browser/mainThreadLocalization.js';

suite('MainThreadLocalization', () => {
	teardown(() => resetNlsResolver());

	function create(resources: Record<string, string>, pack?: URI): MainThreadLocalization {
		return new MainThreadLocalization({ ...createEmptyTestLanguagePacks(), getBuiltInExtensionTranslationsUri: async () => pack }, {
			list: async () => ({ generation: 7, diagnostics: [], extensions: [{ id: 'example.test', name: 'test', publisher: 'example', version: '1.0.0', displayName: 'Test', sourceKind: 'builtIn', manifestSha256: 'sha256:' + 'a'.repeat(64), packageSha256: 'sha256:' + 'b'.repeat(64), manifestJson: JSON.stringify({ l10n: 'l10n' }) }] }),
			resources: {
				readExtensionResourceBytes: async () => { throw new Error('Unused binary resource'); },
				readExtensionResource: async (uri: URI) => {
					const request = extensionResourceRequest(uri)!;
					assert.equal(request.generation, 7);
					assert.equal(request.extensionId, 'example.test');
					if (!(request.path in resources)) throw new Error('Missing optional resource');
					return resources[request.path];
				},
			},
		});
	}

	test('language pack messages override package labels and preserve percent signs in SDK bundles', async () => {
		setNlsMessages('zh-CN', {});
		const contents = { package: { title: '新版标题' }, bundle: { 'Progress {0}%': '进度 {0}%' } };
		const uri = URI.from({ scheme: 'data', path: 'application/json,' + JSON.stringify({ contents }) });
		const service = create({ 'package.nls.json': '{ "title": "English", "other": "Other" }', 'package.nls.zh-cn.json': '{ "title": "旧标题" }' }, URI.parse(uri.toString()));
		assert.deepEqual(JSON.parse(JSON.stringify(await service.getLocalization('example.test'))), { uri: uri.toString(), ...contents });
		assert.deepEqual(JSON.parse(await service.localizeManifest('example.test', '{"title":"%title%","nested":{"other":"%other%","missing":"%missing%"}}', 7)), { title: '新版标题', nested: { other: 'Other', missing: '%missing%' } });
	});

	test('damaged packs fall back to regional and base extension bundles', async () => {
		setNlsMessages('fr-CA', {});
		const service = create({ 'l10n/bundle.l10n.fr.json': '// Translator comment\n{"Hello":"Bonjour"}', 'package.nls.json': '{"title":"English"}', 'package.nls.fr.json': '{"title":"Français"}' }, URI.from({ scheme: 'data', path: 'application/json,{broken' }));
		const localization = await service.getLocalization('example.test');
		assert.deepEqual({ ...localization?.bundle }, { Hello: 'Bonjour' });
		assert.equal(extensionResourceRequest(URI.parse(localization!.uri))?.path, 'l10n/bundle.l10n.fr.json');
		assert.equal(JSON.parse(await service.localizeManifest('example.test', '{"title":"%title%"}', 7)).title, 'Français');
	});

	test('English uses original declarations and missing translations do not block activation', async () => {
		setNlsMessages('en', {});
		const service = create({ 'package.nls.json': '{"title":"English"}' });
		assert.equal(await service.getLocalization('example.test'), undefined);
		assert.equal(JSON.parse(await service.localizeManifest('example.test', '{"title":"%title%"}', 7)).title, 'English');
		setNlsMessages('de', {});
		assert.equal(await service.getLocalization('example.test'), undefined);
	});
});
