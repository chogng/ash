import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { BROWSER_SEARCH_NONE, BrowserSearchEngineId, BrowserSearchEngineSettingId } from '../common/browserSearch.js';
import { BrowserCDPSettingId, BrowserChatToolsSettingId, BrowserOpenLocalhostLinksSettingId } from '../../../../platform/browserView/common/browserView.js';
import { BrowserNewTabPlacementSettingId, type BrowserNewTabPlacement } from '../common/browserView.js';

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

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: BrowserChatToolsSettingId, defaultValue: true, scope: ConfigurationScope.WINDOW,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Invalid browser tools preference'); } return value; },
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.workbench', key: 'browser.chatToolsSetting' }, 'Allow Agent browser tools'); },
		get description() { return localize({ bundle: 'ash.workbench', key: 'browser.chatToolsDescription' }, 'Allow agents to open, observe and interact with isolated browser pages. Turning this off cancels browser operations, closes Agent pages and revokes shared page access.'); },
	},
});
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: BrowserCDPSettingId, defaultValue: false, scope: ConfigurationScope.APPLICATION,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Invalid CDP preference'); } return value; },
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.workbench', key: 'browser.cdpSetting' }, 'Allow advanced browser control (CDP)'); },
		get description() { return localize({ bundle: 'ash.workbench', key: 'browser.cdpDescription' }, 'Allow agents to send reviewed Chrome DevTools Protocol commands to isolated Agent pages. File uploads require the task’s file permissions; direct host filesystem access is blocked. Turning this off releases CDP connections and temporary contexts.'); },
	},
});
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: BrowserOpenLocalhostLinksSettingId, defaultValue: false, agentsWindow: { default: true }, scope: ConfigurationScope.WINDOW,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Invalid localhost link preference'); } return value; },
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.workbench', key: 'browser.localLinksSetting' }, 'Open localhost links in Browser'); },
		get description() { return localize({ bundle: 'ash.workbench', key: 'browser.localLinksDescription' }, 'Open localhost links (such as localhost, 127.0.0.1 and [::1]) and all-interfaces links (such as 0.0.0.0 and [::]) from Chat, terminals and other sources in the integrated browser. When disabled, these links open in the system browser by default.'); },
	},
});
Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<BrowserNewTabPlacement>({
	key: BrowserNewTabPlacementSettingId, defaultValue: 'activeGroup', agentsWindow: { default: 'activeGroup', readOnly: true }, scope: ConfigurationScope.WINDOW,
	parse: value => {
		if (value === 'activeGroup' || value === 'sideGroup' || value === 'window') return value;
		throw new TypeError('Invalid browser tab placement');
	},
	setting: {
		valueType: 'select',
		get title() { return localize({ bundle: 'ash.workbench', key: 'browser.tabPlacement' }, 'New browser tab placement'); },
		get description() { return localize({ bundle: 'ash.workbench', key: 'browser.tabPlacementDescription' }, 'Choose where new browser tabs open in the IDE. The side group and separate window are reserved for browser tabs.'); },
		options: [
			{ value: 'activeGroup', get label() { return localize({ bundle: 'ash.workbench', key: 'browser.tabPlacementActive' }, 'Active Editor Group'); } },
			{ value: 'sideGroup', get label() { return localize({ bundle: 'ash.workbench', key: 'browser.tabPlacementSide' }, 'Browser Group to the Side'); } },
			{ value: 'window', get label() { return localize({ bundle: 'ash.workbench', key: 'browser.tabPlacementWindow' }, 'Separate Browser Window'); } },
		],
	},
});
