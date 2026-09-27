import assert from 'node:assert/strict';
import { test } from 'mocha';
import { resetNlsResolver, setNlsResolver } from '../../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { SessionsConfiguration } from '../../common/configuration.js';
import { builtinLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';

test('Sessions layout setting resolves its own Chinese metadata', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.ok(chinese);
	setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
	try {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const setting = registry.getConfiguration(SessionsConfiguration.layoutStyle)?.setting;
		assert.ok(setting);
		assert.equal(setting.title, '会话布局样式');
		assert.equal(setting.description, '选择会话窗口中悬浮的 Modern 界面或贴边的 Flat 界面。');
	} finally {
		resetNlsResolver();
	}
});
