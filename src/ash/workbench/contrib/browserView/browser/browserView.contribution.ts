import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	ConfigurationScope,
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { BROWSER_SEARCH_NONE, BrowserSearchEngineId, BrowserSearchEngineSettingId } from '../common/browserSearch.js';
import { BrowserCDPSettingId, BrowserChatToolsSettingId } from '../../../../platform/browserView/common/browserView.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: BrowserSearchEngineSettingId,
	defaultValue: BROWSER_SEARCH_NONE,
	parse: value => {
		if (
			typeof value !== 'string' ||
			(value !== BROWSER_SEARCH_NONE &&
				!Object.values(BrowserSearchEngineId).includes(value as BrowserSearchEngineId))
		) {
			throw new TypeError('Invalid browser search engine');
		}
		return value;
	},
	setting: {
		valueType: 'select',
		options: [
			{
				value: BROWSER_SEARCH_NONE,
				get label() {
					return localize({ bundle: 'ash.workbench', key: 'browser.searchDisabled' }, 'Search disabled');
				},
			},
			...Object.values(BrowserSearchEngineId).map(value => ({ value, label: value })),
		],
		get title() {
			return localize({ bundle: 'ash.workbench', key: 'browser.searchEngine' }, 'Browser search engine');
		},
		get description() {
			return localize(
				{ bundle: 'ash.workbench', key: 'browser.searchEngineDescription' },
				'Use none to disable address bar search, or choose bing, google, yahoo or duckduckgo.',
			);
		},
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: BrowserChatToolsSettingId,
	defaultValue: true,
	scope: ConfigurationScope.WINDOW,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError('Invalid browser tools preference');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() {
			return localize({ bundle: 'ash.workbench', key: 'browser.chatToolsSetting' }, 'Allow Agent browser tools');
		},
		get description() {
			return localize(
				{ bundle: 'ash.workbench', key: 'browser.chatToolsDescription' },
				'Allow agents to open, observe and interact with isolated browser pages. Turning this off cancels browser operations, closes Agent pages and revokes shared page access.',
			);
		},
	},
});
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: BrowserCDPSettingId,
	defaultValue: false,
	scope: ConfigurationScope.APPLICATION,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError('Invalid CDP preference');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() {
			return localize(
				{ bundle: 'ash.workbench', key: 'browser.cdpSetting' },
				'Allow advanced browser control (CDP)',
			);
		},
		get description() {
			return localize(
				{ bundle: 'ash.workbench', key: 'browser.cdpDescription' },
				'Allow agents to send reviewed Chrome DevTools Protocol commands to isolated Agent pages. File uploads require the task’s file permissions; direct host filesystem access is blocked. Turning this off releases CDP connections and temporary contexts.',
			);
		},
	},
});
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'workbench.browser.openLocalhostLinks',
	defaultValue: false,
	scope: ConfigurationScope.WINDOW,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError('Invalid localhost link preference');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() {
			return localize(
				{ bundle: 'ash.workbench', key: 'browser.localLinksSetting' },
				'Open localhost links in Browser',
			);
		},
		get description() {
			return localize(
				{ bundle: 'ash.workbench', key: 'browser.localLinksDescription' },
				'Open localhost, 127.0.0.1 and [::1] links from Chat, terminals and other sources in the integrated browser.',
			);
		},
	},
});
