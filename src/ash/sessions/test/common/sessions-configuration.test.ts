import '../../../workbench/contrib/codeEditor/common/editorConfiguration.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { resetNlsResolver, setNlsResolver } from '../../../nls.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { SESSIONS_DIFF_VIEW_MODE, SESSIONS_DIFF_WORD_WRAP, SESSIONS_EDITOR_WORD_WRAP, SessionsConfiguration } from '../../common/configuration.js';
import { ActivityBarPosition, WorkbenchConfiguration } from '../../../workbench/common/configuration.js';
import { TestConfigurationFiles, TestConfigurationService as WorkbenchConfigurationService, testConfigurationService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';

test('Sessions settings keep their values while their labels belong to the Sessions page', () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.ok(chinese);
	setNlsResolver((bundle, key, fallback) => chinese.bundles[bundle]?.[key] ?? fallback);
	try {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const layoutSetting = registry.getConfiguration(SessionsConfiguration.layoutStyle)?.setting;
		assert.ok(layoutSetting);
		assert.equal(layoutSetting.included, false);
		assert.equal(layoutSetting.title, '布局样式');
		assert.equal(layoutSetting.valueType, 'select');
		assert.deepEqual(layoutSetting.options, [{ value: 'modern', label: 'Modern' }, { value: 'flat', label: 'Flat' }]);
		const activityBarSetting = registry.getConfiguration(SessionsConfiguration.activityBarLocation)?.setting;
		assert.ok(activityBarSetting?.valueType === 'select');
		assert.equal(activityBarSetting.description, '将活动栏放在侧边、顶部或底部。');
		assert.deepEqual(activityBarSetting.options.map(option => option.value), ['default', 'top', 'bottom']);
		const inputLayout = registry.getConfiguration(SessionsConfiguration.chatInputLayout)?.setting;
		assert.ok(inputLayout?.valueType === 'select');
		assert.equal(inputLayout.title, 'Chat 输入框布局');
		assert.deepEqual(inputLayout?.options, [{ value: 'compact', label: '单行' }, { value: 'stacked', label: '分层' }]);
		assert.equal(chinese.bundles.ash?.['sessions.settings.title'], '设置');
		assert.equal(registry.getConfiguration(SESSIONS_DIFF_VIEW_MODE)?.setting?.title, '差异视图');
		for (const [key, label] of Object.entries({
			'sessions.settings.section.basics': '基础',
			'sessions.settings.section.development': '开发',
			'sessions.settings.section.management': '管理',
			'sessions.settings.general': '通用',
			'sessions.settings.account': '账号',
			'sessions.settings.appearance': '外观',
			'sessions.settings.customize': '自定义',
			'sessions.settings.agents': '智能体',
			'sessions.settings.models': '模型',
			'sessions.settings.gitPrs': 'Git 与 PR',
			'sessions.settings.browser': '浏览器',
			'sessions.settings.tab': '标签页',
			'sessions.settings.codeIntelligence': '代码智能',
			'sessions.settings.environment': '环境',
			'sessions.settings.shortcuts': '快捷键',
		})) {
			assert.equal(chinese.bundles.ash?.[key], label);
		}
	} finally {
		resetNlsResolver();
	}
});

test('Activity Bar positions persist as strings and legacy Hidden falls back only in Sessions', async () => {
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
			[SessionsConfiguration.activityBarLocation]: 'hidden',
		}), saved.revision);
		assert.equal(configuration.getValue(WorkbenchConfiguration.activityBarLocation), ActivityBarPosition.HIDDEN);
		assert.equal(configuration.getValue(SessionsConfiguration.activityBarLocation), ActivityBarPosition.DEFAULT);
	} finally {
		configuration.dispose();
	}
});


test('Agents Window editor preferences override inherited settings only in that window', async () => {
	const { ConfigurationService } = await import('../../services/configuration/browser/configurationService.js');
	const SessionsConfigurationService = testConfigurationService(ConfigurationService);
	using sessions = new SessionsConfigurationService();
	using workbench = new WorkbenchConfigurationService();
	for (const configuration of [sessions, workbench]) {
		await configuration.updateValue('diffEditor.renderSideBySide', true);
		await configuration.updateValue('diffEditor.wordWrap', 'off');
	}
	assert.equal(sessions.getValue('diffEditor.renderSideBySide'), true);
	const changes: string[] = [];
	using listener = sessions.onDidChangeConfiguration(event => {
		for (const key of ['diffEditor.renderSideBySide', 'diffEditor.wordWrap', 'editor.wordWrap']) {
			if (event.affectsConfiguration(key, { overrideIdentifier: 'typescript' })) changes.push(key);
		}
	});
	for (const configuration of [sessions, workbench]) {
		await configuration.updateValue(SESSIONS_DIFF_VIEW_MODE, 'inline');
		await configuration.updateValue(SESSIONS_DIFF_WORD_WRAP, 'on');
		await configuration.updateValue(SESSIONS_EDITOR_WORD_WRAP, 'on');
	}
	assert.deepEqual(changes, ['diffEditor.renderSideBySide', 'diffEditor.wordWrap', 'editor.wordWrap']);
	assert.equal(sessions.getValue('diffEditor.renderSideBySide'), false);
	assert.equal(sessions.getValue('diffEditor.wordWrap'), 'on');
	assert.equal(sessions.getValue('editor.wordWrap'), 'on');
	assert.equal(workbench.getValue('diffEditor.renderSideBySide'), true);
	assert.equal(workbench.getValue('diffEditor.wordWrap'), 'off');
	await sessions.updateValue(SESSIONS_DIFF_VIEW_MODE, 'inherit');
	assert.equal(sessions.getValue('diffEditor.renderSideBySide'), true);
});

test('Agent Window terminal settings are independent in the shared profile document', async () => {
	const { ConfigurationService } = await import('../../services/configuration/browser/configurationService.js');
	const SessionsConfigurationService = testConfigurationService(ConfigurationService);
	using files = new TestConfigurationFiles();
	using sessions = new SessionsConfigurationService({ files });
	using workbench = new WorkbenchConfigurationService({ files });
	const defaultProfile = 'terminal.integrated.defaultProfile.osx';
	const fontSize = 'terminal.integrated.fontSize';
	const changes: string[] = [];
	using listener = sessions.onDidChangeConfiguration(event => {
		for (const key of [defaultProfile, fontSize]) {
			if (event.affectsConfiguration(key)) changes.push(key);
		}
	});
	await workbench.updateValue(defaultProfile, 'IDE profile');
	await workbench.updateValue(fontSize, 21);
	await sessions.reloadConfiguration();
	assert.equal(sessions.getValue(defaultProfile), null);
	assert.equal(sessions.inspect(fontSize).userLocalValue, undefined);
	assert.deepEqual(changes, []);
	await sessions.updateValue(defaultProfile, 'Agent profile');
	await sessions.updateValue('sessions.terminal.fontSize', 17);
	await workbench.reloadConfiguration();
	assert.equal(workbench.getValue(defaultProfile), 'IDE profile');
	assert.equal(workbench.getValue(fontSize), 21);
	assert.equal(sessions.getValue(defaultProfile), 'Agent profile');
	assert.equal(sessions.getValue<{ fontSize: number; }>('terminal.integrated').fontSize, 17);
	assert.equal(sessions.inspect(fontSize).userLocalValue, 17);
	assert.deepEqual(changes, [defaultProfile, fontSize]);
	assert.deepEqual(JSON.parse((await sessions.read()).source), {
		[defaultProfile]: 'IDE profile',
		[fontSize]: 21,
		'sessions.terminal.defaultProfile.osx': 'Agent profile',
		'sessions.terminal.fontSize': 17,
	});
});


test('Chat input layout defaults to one line, persists in the profile and rejects invalid values', async () => {
	using files = new TestConfigurationFiles();
	using configuration = new WorkbenchConfigurationService({ files });
	const key = SessionsConfiguration.chatInputLayout;
	assert.equal(configuration.getValue(key), 'compact');
	await configuration.updateValue(key, 'stacked');
	using reopened = new WorkbenchConfigurationService({ files });
	await reopened.reloadConfiguration();
	assert.equal(reopened.getValue(key), 'stacked');
	await assert.rejects(configuration.updateValue(key, 'wide'), /Choose Single line or Stacked/);
	assert.equal(configuration.getValue(key), 'stacked');
	await configuration.updateValue(key, 'compact');
	await reopened.reloadConfiguration();
	assert.equal(reopened.getValue(key), 'compact');
});
