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
		for (const [key, label] of Object.entries({
			'sessions.settings.section.basics': '基础',
			'sessions.settings.section.development': '开发',
			'sessions.settings.section.management': '管理',
			'sessions.settings.general': '通用',
			'sessions.settings.account': '账号',
			'sessions.settings.appearance': '外观',
			'sessions.settings.voice': '语音',
			'sessions.settings.personalization': '个性化',
			'sessions.settings.agents': '智能体',
			'sessions.settings.models': '模型',
			'sessions.settings.gitPrs': 'Git 与 PR',
			'sessions.settings.worktree': 'Worktree',
			'sessions.settings.browser': '浏览器',
			'sessions.settings.tab': '标签页',
			'sessions.settings.codeIntelligence': '代码智能',
			'sessions.settings.environment': '环境',
			'sessions.settings.plugins': '插件',
			'sessions.settings.shortcuts': '快捷键',
			'sessions.settings.archivedChats': '已归档聊天',
		})) {
			assert.equal(chinese.bundles.ash?.[key], label);
		}
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
