import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { BROWSER_SEARCH_NONE, BrowserSearchEngineId, BrowserSearchEngineSettingId } from '../common/browserSearch.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: BrowserSearchEngineSettingId, defaultValue: BROWSER_SEARCH_NONE,
	parse: value => {
		if (typeof value !== 'string' || (value !== BROWSER_SEARCH_NONE && !Object.values(BrowserSearchEngineId).includes(value as BrowserSearchEngineId))) { throw new TypeError('Invalid browser search engine'); }
		return value;
	},
	setting: {
		valueType: 'select',
		options: [
			{ value: BROWSER_SEARCH_NONE, get label() { return localize({ bundle: 'ash.workbench', key: 'browser.searchDisabled' }, 'Search disabled'); } },
			...Object.values(BrowserSearchEngineId).map(value => ({ value, label: value })),
		],
		get title() { return localize({ bundle: 'ash.workbench', key: 'browser.searchEngine' }, 'Browser search engine'); },
		get description() { return localize({ bundle: 'ash.workbench', key: 'browser.searchEngineDescription' }, 'Use none to disable address bar search, or choose bing, google, yahoo or duckduckgo.'); },
	},
});


import { ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'workbench.browser.openLocalhostLinks', defaultValue: false, scope: ConfigurationScope.WINDOW,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Invalid localhost link preference'); } return value; },
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.workbench', key: 'browser.localLinksSetting' }, 'Open localhost links in Browser'); },
		get description() { return localize({ bundle: 'ash.workbench', key: 'browser.localLinksDescription' }, 'Open localhost, 127.0.0.1 and [::1] links from Chat, terminals and other sources in the integrated browser.'); },
	},
});
