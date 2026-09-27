import assert from 'node:assert/strict';
import { test } from 'mocha';
import { resetNlsResolver, setNlsResolver } from '../../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { SessionsConfiguration } from '../../common/configuration.js';
import { ActivityBarPosition, WorkbenchConfiguration } from '../../../workbench/common/configuration.js';
import { WorkbenchConfigurationService } from '../../../workbench/services/configuration/browser/configurationService.js';
import { builtinLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';

test('Sessions settings keep their values while their labels belong to the Sessions page', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.ok(chinese);
	setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
	try {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		assert.equal(registry.getConfiguration(SessionsConfiguration.layoutStyle)?.setting, undefined);
		assert.equal(chinese.bundles.ash?.['sessions.settings.title'], '会话设置');
	} finally {
		resetNlsResolver();
	}
});

test('Activity Bar position enum keeps Workbench and Sessions settings as strings', async () => {
	const configuration = new WorkbenchConfigurationService();
	try {
		await configuration.updateValue(WorkbenchConfiguration.activityBarLocation, ActivityBarPosition.TOP);
		await configuration.updateValue(SessionsConfiguration.activityBarLocation, ActivityBarPosition.BOTTOM);
		const saved = await configuration.read();
		assert.deepEqual(JSON.parse(saved.source), {
			[WorkbenchConfiguration.activityBarLocation]: 'top',
			[SessionsConfiguration.activityBarLocation]: 'bottom',
		});
		await configuration.write(JSON.stringify({
			[WorkbenchConfiguration.activityBarLocation]: 'hidden',
			[SessionsConfiguration.activityBarLocation]: 'top',
		}), saved.revision);
		assert.equal(configuration.getValue(WorkbenchConfiguration.activityBarLocation), ActivityBarPosition.HIDDEN);
		assert.equal(configuration.getValue(SessionsConfiguration.activityBarLocation), ActivityBarPosition.TOP);
	} finally {
		configuration.dispose();
	}
});
