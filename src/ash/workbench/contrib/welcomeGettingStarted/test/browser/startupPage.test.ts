import type { IResourceEditorInput } from '../../../../common/editor.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { WorkspaceContextService } from '../../../../services/workspaces/browser/workspaceContextService.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { isGettingStartedInput } from '../../browser/gettingStartedInput.js';
import { StartupEditorConfigurationKey, StartupPageRunnerContribution } from '../../browser/startupPage.js';
import '../../browser/gettingStarted.contribution.js';

test('Startup editor setting opens Welcome only when the selected workspace permits it', async () => {
	using configuration = new InMemoryConfigurationService();
	const setting = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfiguration(StartupEditorConfigurationKey);
	assert.equal(setting?.defaultValue, 'welcomePage');
	assert.deepEqual(setting?.setting?.valueType, 'select');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		assert.equal(setting?.setting?.title, '启动时的编辑器');
		assert.equal(setting?.setting?.options?.[2]?.label, '仅空工作台显示欢迎页');
	} finally {
		resetNlsResolver();
	}
	const opened: IResourceEditorInput[] = [];
	const editor = {
		onDidActiveEditorChange: Event.None,
		onDidVisibleEditorsChange: Event.None,
		get activeEditor() { return opened.at(-1); },
		get visibleEditors() { return opened; },
		async openEditor(input: IResourceEditorInput) { opened.push(input); },
		focusActiveEditor() { },
	} satisfies IEditorService;
	using workspace = new WorkspaceContextService({ id: 'empty', folders: [] });
	using runner = new StartupPageRunnerContribution(configuration, editor, workspace);
	await runner.onWorkspaceRestored();
	assert.equal(opened.length, 1);
	assert.equal(isGettingStartedInput(opened[0]!), true);
	await runner.onWorkspaceRestored();
	assert.equal(opened.length, 1);

	opened.length = 0;
	workspace.updateWorkspace({ id: 'folder', folders: [{ id: 'folder', uri: URI.file('/folder'), name: 'folder', index: 0 }] });
	await runner.onWorkspaceRestored();
	assert.equal(opened.length, 1);
	assert.equal(isGettingStartedInput(opened[0]!), true);

	opened.length = 0;
	await configuration.updateValue(StartupEditorConfigurationKey, 'none');
	await runner.onWorkspaceRestored();
	assert.equal(opened.length, 0);

	await configuration.updateValue(StartupEditorConfigurationKey, 'welcomePageInEmptyWorkbench');
	workspace.updateWorkspace({ id: 'folder', folders: [{ id: 'folder', uri: URI.file('/folder'), name: 'folder', index: 0 }] });
	await runner.onWorkspaceRestored();
	assert.equal(opened.length, 0);
	await configuration.updateValue(StartupEditorConfigurationKey, 'welcomePage');
	await runner.onWorkspaceRestored();
	assert.equal(opened.length, 1);
	opened.length = 0;
	await configuration.updateValue(StartupEditorConfigurationKey, 'welcomePageInEmptyWorkbench');
	workspace.updateWorkspace({ id: 'empty-again', folders: [] });
	await runner.onWorkspaceRestored();
	assert.equal(opened.length, 1);
});

test('Welcome waits for restored editors and accepts only implemented startup modes', async () => {
	using configuration = new InMemoryConfigurationService();
	await assert.rejects(configuration.updateValue(StartupEditorConfigurationKey, 'readme'), /Unknown startup editor/);
	const opened: IResourceEditorInput[] = [{ resource: URI.file('/restored.txt') }];
	const editor = {
		onDidActiveEditorChange: Event.None,
		onDidVisibleEditorsChange: Event.None,
		get activeEditor() { return opened.at(-1); },
		get visibleEditors() { return opened; },
		async openEditor(input: IResourceEditorInput) { opened.push(input); },
		focusActiveEditor() { },
	} satisfies IEditorService;
	using workspace = new WorkspaceContextService({ id: 'folder', folders: [{ id: 'folder', uri: URI.file('/folder'), name: 'folder', index: 0 }] });
	using runner = new StartupPageRunnerContribution(configuration, editor, workspace);
	await runner.onWorkspaceRestored();
	assert.equal(opened.length, 1);
	assert.equal(isGettingStartedInput(opened[0]!), false);
});
