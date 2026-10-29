import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { BrowserSearchEngineId, BrowserSearchEngineSettingId, buildSearchUrl, resolveAddressBarInputType } from '../../common/browserSearch.js';
import { BrowserSearchFeatures } from '../../electron-browser/features/browserSearchFeatures.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';

suite('Browser address intent', () => {
	test('addresses and search terms take distinct paths without granting access', () => {
		assert.deepEqual(
			['', '  ', 'about:blank', 'https://example.test/a b', 'localhost:5173', '127.0.0.1/path', '[::1]:8080', 'example.com', 'find words', 'user@host', 'intranet'].map(
				resolveAddressBarInputType,
			),
			['empty', 'empty', 'url', 'url', 'url', 'url', 'url', 'url', 'query', 'unknown', 'unknown'],
		);
	});
	test('the production resolver respects disabled search and configured engines', async () => {
		using configuration = new InMemoryConfigurationService(Registry.as<IConfigurationRegistry>(Extensions.Configuration));
		const search = new BrowserSearchFeatures(configuration);
		assert.deepEqual(
			['', 'example.com/path', 'localhost:5173/a', 'two words', 'intranet'].map(value => search.resolve(value)),
			[undefined, 'https://example.com/path', 'http://localhost:5173/a', 'two words', 'https://intranet'],
		);
		await configuration.updateValue(BrowserSearchEngineSettingId, BrowserSearchEngineId.DuckDuckGo, ConfigurationTarget.MEMORY);
		assert.equal(search.resolve('intranet', true), 'https://intranet');
		assert.equal(search.resolve('intranet'), 'https://duckduckgo.com/?q=intranet');
		assert.equal(search.resolve('A & B'), 'https://duckduckgo.com/?q=A+%26+B');
		assert.equal(search.resolve('https://example.test/private'), 'https://example.test/private');
	});
	test('search URL encoding retains Unicode and treats delimiters as query text', () => {
		const url = new URL(buildSearchUrl('  界面  & layout?  ', BrowserSearchEngineId.Google));
		assert.deepEqual([url.origin, url.pathname, url.searchParams.get('q')], ['https://www.google.com', '/search', '界面 & layout?']);
	});
});

import '../../browser/browserView.contribution.js';
