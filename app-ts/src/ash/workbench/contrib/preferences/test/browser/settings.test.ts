import '../../../chat/common/languageModelsConfiguration.js';
import { ILanguageModelsService } from '../../../../contrib/chat/common/languageModels.js';
import type { SettingsContentItem } from '../../browser/settingsTreeModels.js';
import { IFileTextModelService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { IDictationService } from '../../../../../platform/dictation/common/dictationService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../../services/notification/common/notificationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { ISkillService } from '../../../../../platform/skills/common/skillService.js';
import { IMarketplaceService } from '../../../../../platform/marketplace/common/marketplaceService.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { formatNlsMessage, localize, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import type { IAction } from '../../../../../base/common/actions.js';
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IContextMenuService as ContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { ILocalizationService } from '../../../../services/localization/common/localizationService.js';
import type { IGitService } from '../../../git/common/gitService.js';
import type { IChatService } from '../../../../services/chat/common/chatService.js';
import type { IRemoteAgentService } from '../../../../services/remote/common/remoteAgentService.js';
import type { RemoteAgentConnection } from '../../../../../platform/remote/common/remoteAgentApi.js';
import type { RemoteConnectionState } from '../../../../../platform/remote/common/remote.js';
import type { IDirPermissionsService } from '../../../../../platform/dirPermissions/common/dirPermissionsService.js';
import type { ILanguagePackService, LanguagePackInfo } from '../../../../../platform/languagePacks/common/languagePacksService.js';
import type { ILocalTranscriptionModelStatus, ILocalTranscriptionService as LocalTranscriptionService, LocalTranscriptionModelState as ModelState } from '../../../../../platform/localTranscription/common/localTranscription.js';

import { DeferredPromise } from '../../../../../base/common/async.js';
import { IHooksService, type HookSource } from '../../../../../platform/hooks/common/hooksService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { URI } from '../../../../../base/common/uri.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browserEnvironment = new JSDOM('<!doctype html><body></body>', {
	pretendToBeVisual: true,
});
Object.defineProperty(browserEnvironment.window.Element.prototype, 'scrollTo', {
	configurable: true,
	value() {},
});
Object.defineProperty(browserEnvironment.window.Element.prototype, 'scrollIntoView', {
	configurable: true,
	value() {},
});
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	navigator: browserEnvironment.window.navigator,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { h } = await import('../../../../../base/browser/dom.js');
const { Emitter, Event } = await import('../../../../../base/common/event.js');
const { DisposableStore, toDisposable } = await import('../../../../../base/common/lifecycle.js');
const { ConfigurationRegistry, Extensions: ConfigurationExtensions } = await import('../../../../../platform/configuration/common/configurationRegistry.js');
const { IClipboardService: ClipboardServiceId } = await import('../../../../../platform/clipboard/common/clipboardService.js');
const { IConfigurationService: ConfigurationServiceId } = await import('../../../../../platform/configuration/common/configuration.js');
const { IContextMenuService } = await import('../../../../../platform/contextview/browser/contextView.js');
const { IContextViewService } = await import('../../../../../platform/contextview/browser/contextView.js');
const { BrowserContextViewService } = await import('../../../../../platform/contextview/browser/contextViewService.js');
const { InstantiationService } = await import('../../../../../platform/instantiation/common/instantiationService.js');
const { Registry } = await import('../../../../../platform/registry/common/platform.js');
const { darkColorTheme } = await import('../../../../../platform/theme/common/colorTheme.js');
const { AccessibilityConfiguration } = await import('../../../../../platform/accessibility/common/accessibility.js');
const { HoverConfiguration } = await import('../../../../../platform/hover/common/hoverService.js');
const { SashConfiguration } = await import('../../../sash/common/sash.js');
const { DictationConfiguration } = await import('../../../../../platform/dictation/common/dictationConfiguration.js');
const { WorkbenchConfiguration } = await import('../../../../common/configuration.js');
const { SessionsConfiguration } = await import('../../../../../sessions/common/configuration.js');
const { WorkbenchThemesRegistry } = await import('../../../../common/theme.js');
const { EditorSelectionConfiguration } = await import('../../../../common/editorSelectionConfiguration.js');
const { CodeEditorConfiguration } = await import('../../../codeEditor/common/editorConfiguration.js');
const { ContentSearchConfiguration } = await import('../../../search/common/searchConfiguration.js');
const { GitConfiguration } = await import('../../../git/common/gitConfiguration.js');
const { ScmConfiguration } = await import('../../../scm/common/scmConfiguration.js');
const { IGitService: GitServiceId } = await import('../../../git/common/gitService.js');
const { IChatService: ChatServiceId } = await import('../../../../services/chat/common/chatService.js');
await import('../../../../services/chat/common/modelCatalog.js');
const { IAgentCapabilitiesService } = await import('../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js');
const { IRemoteAgentService: RemoteAgentServiceId } = await import('../../../../services/remote/common/remoteAgentService.js');
const { IDirPermissionsService: DirPermissionsServiceId } = await import('../../../../../platform/dirPermissions/common/dirPermissionsService.js');
const configurationRegistry = Registry.as<InstanceType<typeof ConfigurationRegistry>>(ConfigurationExtensions.Configuration);
const { EditorPart } = await import('../../../../browser/parts/editor/editorPart.js');
const { EditorPaneRegistry, EditorPanes } = await import('../../../../browser/editor.js');
const { SettingsSearchQuery } = await import('../../browser/settingsSearch.js');
const { createSettingsLayout, SettingsCategories, SettingsLayout } = await import('../../browser/settingsLayout.js');
const { SettingsEditorId } = await import('../../browser/settingsEditor.js');
const { ILocalTranscriptionService, LocalTranscriptionModelState } = await import('../../../../../platform/localTranscription/common/localTranscription.js');
const { NullLocalTranscriptionService } = await import('../../../../services/localTranscription/browser/localTranscriptionService.js');
const { ModelSettingsContent } = await import('../../../chat/browser/modelSettingsContent.js');
const { LocalTranscriptionModelControls } = await import('../../../localTranscription/browser/localTranscriptionModelControls.js');
const { SettingsTree } = await import('../../browser/settingsTree.js');
const { SettingsTreeModel } = await import('../../browser/settingsTreeModels.js');
const { PreferencesService } = await import('../../../../services/preferences/browser/preferencesService.js');
const { BrowserEditorService } = await import('../../../../services/editor/browser/browserEditorService.js');
const { ILocalizationService: LocalizationServiceId } = await import('../../../../services/localization/common/localizationService.js');
const { DefaultSettings, SettingsEditorModel } = await import('../../../../services/preferences/common/settingsModels.js');
const { WorkbenchConfigurationService } = await import('../../../../services/configuration/browser/configurationService.js');
const { builtinLanguagePackCatalogs } = await import('../../../../services/localization/common/localizationCatalogs.js');
const { ILanguagePackService: LanguagePackServiceId } = await import('../../../../../platform/languagePacks/common/languagePacksService.js');
const { ILocaleService, LocalizationConfiguration } = await import('../../../../services/localization/common/locale.js');
const { WorkbenchLocaleService } = await import('../../../../services/localization/browser/localeService.js');
const { WorkbenchLocalizationService } = await import('../../../../services/localization/browser/workbenchLocalizationService.js');
const { StartupEditorConfigurationKey } = await import('../../../welcomeGettingStarted/browser/startupPage.js');
await import('../../../welcomeGettingStarted/browser/gettingStarted.contribution.js');
await import('../../../../browser/workbench.contribution.js');
await import('../../../../electron-browser/desktop.contribution.js');

const localizationService: ILocalizationService = {
	onDidChange: Event.None,
	whenReady: Promise.resolve(),
	translate: (_bundle, _key, fallback) => fallback,
};

test('DefaultSettings projects only Configuration Registry metadata', () => {
	const registry = new ConfigurationRegistry();
	const visible = registry.registerConfiguration({
		key: 'editor.test.enabled',
		defaultValue: true,
		parse: value => {
			if (typeof value !== 'boolean') throw new TypeError('Expected a boolean');
			return value;
		},
		setting: {
			valueType: 'boolean',
			title: 'Test setting',
			description: 'A registered test setting.',
		},
	});
	registry.registerConfiguration({
		key: 'internal.test.state',
		defaultValue: 'hidden',
		parse: value => String(value),
	});
	registry.registerConfiguration({
		key: 'editor.test.patterns',
		defaultValue: { '*.source': '${capture}.output' },
		parse: value => value as Record<string, string>,
		setting: {
			valueType: 'stringMap',
			title: 'Test patterns',
			description: 'Maps parent patterns to child patterns.',
			keyLabel: 'Parent',
			valueLabel: 'Children',
			addLabel: 'Add',
			removeLabel: 'Remove',
			incompleteMessage: 'Complete both fields.',
			duplicateMessage: 'Duplicate parent.',
		},
	});

	const defaults = new DefaultSettings(registry);
	assert.deepEqual(defaults.all.map(setting => setting.id), ['editor.test.enabled', 'editor.test.patterns']);
	assert.equal(defaults.get(visible).valueType, 'boolean');
	assert.equal(defaults.get('editor.test.patterns').valueType, 'stringMap');
});

test('empty-editor tips expose translated settings metadata', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const tips = defaults.get('workbench.tips.enabled');
		assert.equal(tips.title, '空编辑器提示');
		assert.equal(tips.description, '没有打开编辑器时显示命令快捷键提示。');
	} finally {
		resetNlsResolver();
	}
});

test('file opening preferences have a translated group and correctly typed controls', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		const defaults = new DefaultSettings();
		const group = createSettingsLayout(defaults.all).find(category => category.id === 'editor')?.groups.find(group => group.id === 'file-opening');
		assert.equal(group?.title, '文件打开');
		assert.deepEqual(group?.settings.map(setting => ({ id: setting.id, title: setting.title, valueType: setting.valueType })), [
			{ id: 'workbench.editor.openErrorDialog', title: '文件打开错误弹窗', valueType: 'boolean' },
			{ id: 'workbench.editor.defaultBinaryEditor', title: '默认二进制编辑器', valueType: 'select' },
			{ id: 'workbench.editorLargeFileConfirmation', title: '大文件打开确认（MiB）', valueType: 'number' },
		]);
		const binary = defaults.get('workbench.editor.defaultBinaryEditor');
		assert.equal(binary.valueType === 'select' && binary.options[0]?.label, '默认');
		assert.match(defaults.get('workbench.editor.openErrorDialog').description, /自动恢复文件时不显示错误弹窗/);
		assert.throws(() => configurationRegistry.getConfiguration('workbench.editor.openErrorDialog')?.parse('false'), /文件打开错误弹窗必须为 true 或 false/);
	} finally {
		resetNlsResolver();
	}
});

test('settingsLayout is the single projection from registered settings to categories', () => {
	const defaults = new DefaultSettings();
	const layout = createSettingsLayout(defaults.all);
	const model = new SettingsEditorModel(defaults.all);

	assert.deepEqual(SettingsCategories.map(category => category.id), [
		'general',
		'appearance',
		'layout',
		'startup',
		'editor',
		'agents',
		'teams',
		'agent-defaults',
		'models',
		'rules',
		'skills',
		'tools',
		'sandbox',
		'hooks',
	]);
	assert.deepEqual(model.settings.map(setting => setting.id), defaults.all.map(setting => setting.id));
	assert.equal(findSettingCategory(layout, AccessibilityConfiguration.underlineLinks), 'general');
	assert.equal(findSettingCategory(layout, LocalizationConfiguration.locale), 'general');
	assert.equal(findSettingCategory(layout, HoverConfiguration.delay), 'general');
	assert.equal(findSettingCategory(layout, SashConfiguration.size), 'general');
	assert.equal(findSettingCategory(layout, DictationConfiguration.backend), 'general');
	assert.equal(findSettingCategory(layout, DictationConfiguration.localModel), 'general');
	assert.equal(findSettingCategory(layout, 'chat.defaultModel'), 'models');
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.colorTheme), 'appearance');
	assert.equal(findSettingCategory(layout, 'workbench.tips.enabled'), 'appearance');
	assert.equal(defaults.get('workbench.tips.enabled').valueType, 'boolean');
	assert.equal(configurationRegistry.getConfiguration('workbench.tips.enabled')?.defaultValue, true);
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.layoutStyle), 'layout');
	assert.equal(findSettingCategory(layout, StartupEditorConfigurationKey), 'startup');
	assert.equal(findSettingCategory(layout, 'window.restoreWindows'), 'startup');
	assert.equal(findSettingCategory(layout, 'workbench.editor.restoreEditors'), 'startup');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.equal(chinese?.bundles['ash.settings']?.['categories.startup.label'], '启动');
	assert.equal(chinese?.bundles.ash?.['settings.workbench.startup.group.label'], '启动时的编辑器');
	assert.equal(chinese?.bundles.ash?.['window.restoreWindows.all'], '全部窗口');
	assert.equal(chinese?.bundles.ash?.['workbench.editor.restoreEditors.title'], '恢复编辑器');
	assert.equal(chinese?.bundles.ash?.['workbench.tips.enabled.title'], '空编辑器提示');
	assert.equal(chinese?.bundles.ash?.['settings.dictation.group'], '语音输入');
	assert.equal(defaults.all.some(setting => Object.values(SessionsConfiguration).includes(setting.id)), false);
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.activityBarLocation), 'layout');
	const iconThemeSetting = defaults.get(WorkbenchConfiguration.iconTheme);
	assert.equal(iconThemeSetting.valueType, 'select');
	if (iconThemeSetting.valueType === 'select') {
		assert.equal(iconThemeSetting.options.some(option => option.value === iconThemeSetting.configuration.defaultValue), true);
	}
	assert.equal(findSettingCategory(layout, EditorSelectionConfiguration.defaultNewDocumentEditor), 'editor');
	assert.equal(findSettingCategory(layout, 'breadcrumbs.filePath'), 'editor');
	assert.equal(findSettingCategory(layout, 'breadcrumbs.symbolPath'), 'editor');
	assert.equal(findSettingCategory(layout, 'workbench.editorLargeFileConfirmation'), 'editor');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.fontFamily), 'editor');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.renderWhitespace), 'editor');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.renderControlCharacters), 'editor');
	assert.equal(findSettingCategory(layout, ContentSearchConfiguration.maxResults), 'editor');
	assert.equal(findSettingCategory(layout, ScmConfiguration.diffDecorationsIgnoreTrimWhitespace), 'general');
	assert.equal(findSettingCategory(layout, DictationConfiguration.backend), 'general');
	assert.equal(findSettingCategory(layout, DictationConfiguration.cloudProvider), 'general');
	assert.equal(findSettingCategory(layout, DictationConfiguration.localModel), 'general');
	assert.equal(defaults.all.some(setting => setting.id === GitConfiguration.autofetch), false);
	assert.equal(configurationRegistry.getConfiguration(GitConfiguration.autofetch)?.defaultValue, false);
	assert.equal(configurationRegistry.getConfiguration(GitConfiguration.autofetchPeriod)?.defaultValue, 180);
	assert.equal(defaults.all.every(setting => ['boolean', 'number', 'select', 'text', 'stringMap'].includes(setting.valueType)), true);
	const themeSetting = defaults.get(WorkbenchConfiguration.colorTheme);
	assert.equal(themeSetting.valueType, 'select');
	if (themeSetting.valueType === 'select') {
		using contributedTheme = WorkbenchThemesRegistry.registerColorTheme({
			...darkColorTheme,
			id: 'test-preferences-dynamic-theme',
			label: 'Dynamic test theme',
		});
		assert.equal(themeSetting.options.some(option => option.value === 'test-preferences-dynamic-theme'), true);
	}
	const layoutStyleSetting = defaults.get(WorkbenchConfiguration.layoutStyle);
	assert.equal(layoutStyleSetting.valueType, 'select');
	if (layoutStyleSetting.valueType === 'select') {
		assert.deepEqual(layoutStyleSetting.options, [
			{ value: 'modern', label: 'Modern' },
			{ value: 'flat', label: 'Flat' },
		]);
	}
	assert.throws(() => configurationRegistry.getConfiguration(SessionsConfiguration.layoutStyle)?.parse('other'), /Unknown Sessions layout style/);

	model.dispose();
});

test('SettingsLayout validates stable configuration identities', () => {
	const fontFamily = new DefaultSettings().get(CodeEditorConfiguration.fontFamily);
	const layout = new SettingsLayout('editor', [{
		id: 'typography',
		title: 'Typography',
		description: 'Editor typography.',
		settings: [fontFamily],
	}]);

	assert.equal(layout.nodes[0]?.element.id, 'editor.group.typography');
	assert.equal(layout.nodes[0]?.children?.[0]?.element.id, CodeEditorConfiguration.fontFamily);
	assert.deepEqual(layout.nodes[0]?.children?.[0]?.element.keywords, [CodeEditorConfiguration.fontFamily]);
	assert.throws(() => new SettingsLayout('editor', [{
		id: 'typography',
		title: 'Typography',
		description: '',
		settings: [fontFamily, fontFamily],
	}]), /Duplicate Settings setting ID/);
	assert.throws(() => new SettingsLayout('', []), /TOC ID must not be empty/);
	assert.throws(() => new SettingsLayout('editor', [{
		id: 'typography',
		title: 'Typography',
		description: '',
		settings: [{ ...fontFamily, id: 'editor.font\0Family' }],
	}]), /must not contain control characters/);
});

test('Settings search normalizes pasted setting syntax and matches complete metadata terms', () => {
	const query = new SettingsSearchQuery('  "Editor.Font: Family"  ');

	assert.equal(query.text, 'editor.font family');
	assert.equal(query.matches({
		title: 'Font family',
		description: 'Configure the editor font.',
		keywords: ['editor.fontFamily'],
	}), true);
	assert.equal(query.matches({
		title: 'Font size',
		description: 'Configure the editor font size.',
	}), false);
});

test('Settings search composes setting ID and text filters', () => {
	const query = new SettingsSearchQuery('@id:font editor');

	assert.equal(query.matches({ id: 'editor.fontFamily', title: 'Font family', description: 'Editor typography.' }), true);
	assert.equal(query.matches({ id: 'editor.fontSize', title: 'Font size', description: 'Editor typography.' }), true);
	assert.equal(query.matches({ id: 'workbench.fontFamily', title: 'Font family', description: 'Workbench typography.' }), false);
});

test('Models Settings keeps loading API connections when the model catalog changes', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const root = h(ownerDocument, 'div');
	ownerDocument.body.append(root);
	const configuration = disposables.add(new WorkbenchConfigurationService());
	const contextView = disposables.add(new BrowserContextViewService(root));
	const changed = disposables.add(new Emitter<void>());
	const model = { provider: 'openai', model: 'gpt-test' };
	let catalog = [{ model, displayName: 'GPT Test' }];
	let resolveProviders!: (providers: readonly { connection: string; provider: string; displayName: string; apiKeyPolicy: 'required'; apiKeyConfigured: boolean }[]) => void;
	const providers = new Promise<readonly { connection: string; provider: string; displayName: string; apiKeyPolicy: 'required'; apiKeyConfigured: boolean }[]>(resolve => { resolveProviders = resolve; });
	const chat = {
		onDidChangeModels: changed.event,
		listModelCatalog: async () => catalog,
		listModelProviders: () => providers,
		listCustomModelProviders: async () => [],
		isModelVisible: () => true,
	} as unknown as IChatService;
	const services = disposables.add(new InstantiationService());
	services.registerInstance(ILocalTranscriptionService, disposables.add(new NullLocalTranscriptionService()));
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(ChatServiceId, chat);
	services.registerInstance(INotificationService, disposables.add(new NotificationService()));
	services.registerInstance(ILanguageModelsService, chat as unknown as ILanguageModelsService);
	services.registerInstance(IContextViewService, disposables.add(new BrowserContextViewService(root)));
	services.registerInstance(IAccessibleViewService, { show: () => true, getOpenAriaHint: () => undefined, dispose() {}, [Symbol.dispose]() {} });
	const panel = disposables.add(services.createInstance(ModelSettingsContent, root));
	const modelTree = disposables.add(new SettingsTreeModel<SettingsContentItem>());
	disposables.add(new SettingsTree(root, {
		model: modelTree, rootClassName: 'ash-models-settings', groupClassName: 'ash-settings-content-group', groupDescriptionClassName: 'ash-settings-group-description', itemsClassName: 'ash-settings-list', renderItem: item => item.value.domNode,
	}));
	disposables.add(panel.onDidChange(() => modelTree.setChildren(panel.getNodes())));
	panel.setVisible(true);
	modelTree.setNavigationTarget('models.catalog');
	await nextTurn();
	assert.equal(root.querySelector('.ash-models-settings-model-copy > span')?.textContent, 'GPT Test');
	const retainedModel = root.querySelector('.ash-models-settings-model-row');
	modelTree.setNavigationTarget(undefined);
	catalog = [{ model, displayName: 'GPT Test Updated' }];
	changed.fire();
	resolveProviders([{ connection: 'openai', provider: 'openai', displayName: 'OpenAI API', apiKeyPolicy: 'required', apiKeyConfigured: false }]);
	await nextTurn();
	assert.equal(root.querySelector('.ash-models-settings-api-row h5')?.textContent, 'OpenAI API');
	assert.equal(root.querySelector('.ash-models-settings-model-row'), retainedModel);
	assert.equal(root.querySelector('.ash-models-settings-model-copy > span')?.textContent, 'GPT Test Updated');
});

test('Settings tree preserves item identity while filtering and updating', () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const model = disposables.add(new SettingsTreeModel<string>());
	model.setChildren([{
		element: { kind: 'group', id: 'appearance.colors', title: 'Colors', description: 'Choose the active color scheme.' },
		children: [
			{ element: { kind: 'item', id: 'appearance.colors.theme', title: 'Theme', description: 'Choose a theme.', value: 'Theme' } },
			{ element: { kind: 'item', id: 'appearance.colors.font', title: 'Font family', description: 'Choose a UI font.', value: 'Font' } },
		],
	}]);
	const disposedItems: string[] = [];
	const renderer = disposables.add(new SettingsTree(ownerDocument.body, {
		model,
		rootClassName: 'test-settings-tree',
		groupClassName: 'test-settings-group',
		groupDescriptionClassName: 'test-settings-group-description',
		itemsClassName: 'test-settings-items',
		renderItem: item => {
			const element = h(ownerDocument, 'article');
			element.textContent = item.value;
			return element;
		},
		updateItem: (item, element) => { element.textContent = item.value; },
		disposeItem: item => disposedItems.push(item.id),
	}));

	const themeElement = renderer.getItemElement('appearance.colors.theme');
	assert.ok(themeElement);
	model.setQuery('font family');
	assert.deepEqual(model.visibleItems.map(item => item.id), ['appearance.colors.font']);
	model.setQuery('');
	assert.equal(renderer.getItemElement('appearance.colors.theme'), themeElement);
	model.setNodeChildren('appearance.colors', [{
		element: { kind: 'item', id: 'appearance.colors.theme', title: 'Theme', description: 'Choose a theme.', value: 'Updated Theme' },
	}]);
	assert.equal(themeElement.textContent, 'Updated Theme');
	assert.deepEqual(disposedItems, ['appearance.colors.font']);
	assert.throws(() => model.setChildren([
		{ element: { kind: 'item', id: 'duplicate', title: 'One', description: '', value: 'one' } },
		{ element: { kind: 'item', id: 'duplicate', title: 'Two', description: '', value: 'two' } },
	]), /Duplicate tree node ID/);
});

test('SettingsEditor opens directly and updates registry-backed settings', async () => {
	using disposables = new DisposableStore();
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	const root = h(ownerDocument, 'div');
	const trigger = h(ownerDocument, 'button');
	trigger.textContent = 'Open Settings';
	root.append(trigger);
	ownerDocument.body.append(root);
	trigger.focus();

	const copied: string[] = [];
	let menuActions: readonly IAction[] = [];
	let hideMenu: ((didCancel: boolean) => void) | undefined;
	const clipboardService: IClipboardService = {
		readText: async () => '',
		readResources: async () => ({ resources: [], operation: 'copy' }),
		writeResources: async () => {},
		hasResources: async () => false,
		writeText: value => {
			copied.push(value);
			return Promise.resolve();
		},
	};
	const contextMenuProvider: ContextMenuService = {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu: options => {
			menuActions = options.getActions?.() ?? [];
			hideMenu = 'onHide' in options ? options.onHide : undefined;
		},
		hideContextMenu() {},
	};
	const configuration = disposables.add(new WorkbenchConfigurationService());
	const languagePacksChanged = disposables.add(new Emitter<void>());
	const availableLocales: LanguagePackInfo[] = builtinLanguagePackCatalogs.map(catalog => ({ ...catalog, source: 'builtin' }));
	const languagePacks: ILanguagePackService = {
		onDidChange: languagePacksChanged.event,
		whenReady: Promise.resolve(),
		catalogs: builtinLanguagePackCatalogs,
		availableLocales,
		installedPackages: [],
		search: async () => [],
		install: async () => {},
		refresh: async () => {},
	};
	const locale = disposables.add(new WorkbenchLocaleService(configuration, languagePacks));
	await locale.whenReady;
	const workbenchLocalization = disposables.add(new WorkbenchLocalizationService(locale, languagePacks));
	disposables.add(toDisposable(() => resetNlsResolver()));
	const autoFetchChanged = disposables.add(new Emitter<void>());
	let autoFetch: false | true | 'all' = false;
	let autoFetchPeriod = 180;
	const gitService = {
		onDidChangeAutoFetch: autoFetchChanged.event,
		get autoFetch() { return autoFetch; },
		get autoFetchPeriod() { return autoFetchPeriod; },
		setAutoFetch: async (value: false | true | 'all') => { autoFetch = value; autoFetchChanged.fire(); },
		setAutoFetchPeriod: async (value: number) => { autoFetchPeriod = value; autoFetchChanged.fire(); },
	} as IGitService;
	const model = { provider: 'openai', model: 'gpt-test' };
	const modelsChanged = disposables.add(new Emitter<void>());
	let modelVisible = true;
	const modelWrites: boolean[] = [];
	const savedKeys: string[] = [];
	const advisorModel = { provider: 'openai', model: 'gpt-6.1-sol' };
	const otherAdvisorModel = { provider: 'meta', model: 'muse-spark-1.3' };
	const hiddenAdvisors = new Set<string>();
	let advisor: import('../../../../services/chat/common/chatService.js').AdvisorConfig | null = { model: advisorModel, enabled: true, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' };
	const advisorWrites: (typeof advisor | null)[] = [];
	let rejectAdvisorSave = false;
	const chatService = {
		onDidChangeModels: modelsChanged.event,
		listAdvisorModels: async () => [{ model: advisorModel, displayName: 'GPT-6.1 Sol' }, { model: otherAdvisorModel, displayName: 'Muse Spark 1.3', supportedReasoningEfforts: ['high'] }, { model, displayName: 'GPT Test' }],
		readAdvisorDefault: async () => advisor,
		saveAdvisorDefault: async (next: typeof advisor) => {
			if (rejectAdvisorSave) { throw new Error('Preference write failed'); }
			advisor = next;
			advisorWrites.push(next);
		},
		listModelCatalog: async () => [{ model, displayName: 'GPT Test' }],
		listCustomModelProviders: async () => [],
		listModelProviders: async () => [{ connection: 'openai', provider: 'openai', displayName: 'OpenAI API', apiKeyPolicy: 'required', apiKeyConfigured: savedKeys.length > 0 }],
		isModelVisible: (entry: typeof model) => entry.model === model.model ? modelVisible : !hiddenAdvisors.has(entry.model),
		setModelVisible: async (_model: typeof model, visible: boolean) => {
			modelWrites.push(visible);
			modelVisible = visible;
			modelsChanged.fire();
		},
		setModelProviderApiKey: async (_connection: string, key: string) => { savedKeys.push(key); },
		refreshModels: async () => [{ model, displayName: 'GPT Test' }],
	} as unknown as IChatService;
	const contextView = disposables.add(new BrowserContextViewService(root));
	const services = new InstantiationService();
	services.registerInstance(INotificationService, disposables.add(new NotificationService()));
	services.registerInstance(IDictationService, undefined);
	services.registerInstance(IChatSpeechToTextService, disposables.add(services.createInstance(ChatSpeechToTextService)));
	services.registerInstance(ISkillService, {
		list: async () => ({ generation: 0, skills: [] }),
		read: async () => ({ revision: 0, catalog: { generation: 0, skills: [] }, diagnostics: [] }),
		setEnabled: async () => {},
	});
	services.registerInstance(IMarketplaceService, { onDidChangeInstalled: Event.None } as IMarketplaceService);
	services.registerInstance(IDialogService, disposables.add(new DialogService()));
	services.registerInstance(ClipboardServiceId, clipboardService);
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IContextMenuService, contextMenuProvider);
	services.registerInstance(IContextViewService, contextView);
	services.registerInstance(LocalizationServiceId, workbenchLocalization);
	services.registerInstance(GitServiceId, gitService);
	services.registerInstance(ChatServiceId, chatService);
	services.registerInstance(ILanguageModelsService, chatService as unknown as ILanguageModelsService);
	services.registerInstance(ILocalTranscriptionService, disposables.add(new NullLocalTranscriptionService()));
	const descriptor = EditorPanes.getEditorPanes().find(candidate => candidate.id === SettingsEditorId);
	assert.ok(descriptor);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: localeService/);
	services.registerInstance(ILocaleService, locale);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: languagePackService/);
	services.registerInstance(LanguagePackServiceId, languagePacks);
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: agentCapabilitiesService/);
	let capabilityReads = 0;
	services.registerInstance(IAgentCapabilitiesService, {
		read: async () => {
			capabilityReads++;
			return {
				tools: [{ name: 'read_file', description: 'Read a file.', source: 'local', sourceDetails: ['ash-app-server'], exposure: 'direct', authority: 'directoryRead' }],
				localProcessSandboxConfigured: true,
				sandboxBackends: ['mxc'],
				directoryGrantsReadable: true,
			};
		},
	});
	assert.throws(() => descriptor.create({ instantiationService: services }), /Unknown service: remoteAgentService/);
	const connectionChanged = disposables.add(new Emitter<RemoteConnectionState>());
	const connectionIdentityChanged = disposables.add(new Emitter<RemoteAgentConnection>());
	let connectionIdentity: RemoteAgentConnection = { kind: 'local', generation: 1 };
	services.registerInstance(RemoteAgentServiceId, {
		onDidChangeConnectionState: connectionChanged.event,
		onDidChangeConnection: connectionIdentityChanged.event,
		connectionState: 'connected',
		get connection() { return connectionIdentity; },
		reconnect: async () => ({ kind: 'alreadyConnected' }),
		rollbackRuntime: async () => ({ kind: 'cancelled' }),
	});
	services.registerInstance(DirPermissionsServiceId, {
		onDidChangePermissions: Event.None,
		list: async () => ({ revision: 1, entries: [{ dir: 'dir-1', path: '/workspace', permissions: ['readFiles'] }] }),
	} as unknown as IDirPermissionsService);
	let hookReads = 0;
	let hooksFailure = false;
	let openUserToml = 0;
	let sources: readonly HookSource[] = [{ namespace: 'user', configPath: '/profile/config.toml', hooks: [{
		id: 'user:hook:check', event: 'preToolUse', enabled: false, toolNames: ['shell-command'], program: '/program with spaces', args: ['two words', '"quote"'],
	}] }];
	const hooksChanged = disposables.add(new Emitter<void>());
	let nextHooksRead: Promise<readonly HookSource[]> | undefined;
	const hooksService: IHooksService = {
		onDidChange: hooksChanged.event,
		userConfigurationEditor: async () => { openUserToml++; },
		read: async sessionId => {
			hookReads++;
			assert.equal(sessionId, 'session-hooks');
			if (hooksFailure) throw new Error('Invalid TOML');
			const pending = nextHooksRead;
			nextHooksRead = undefined;
			return pending ?? sources;
		},
	};
	const prompts: string[] = [];
	services.registerInstance(IChatSessionNavigationService, {
		getActiveConversation: () => ({ sessionId: 'session-hooks', threadId: 'thread-hooks' }),
		getConversations: () => [], captureActiveDraft: async () => undefined, openConversation: async () => {},
		appendToActiveDraft: text => { prompts.push(text); },
	});
	services.registerInstance(IAccessibleViewService, { show: () => true, getOpenAriaHint: () => undefined, dispose() {}, [Symbol.dispose]() {} });
	const hooksFolder = await mkdtemp(join(tmpdir(), 'ash-settings-hooks-'));
	await using hooksFolderCleanup = { [Symbol.asyncDispose]: async () => { await rm(hooksFolder, { recursive: true, force: true }); } };
	services.registerInstance(IFileService, disposables.add(new DiskFileSystemProvider([URI.file(hooksFolder)])));
	const editorPanes = new EditorPaneRegistry();
	disposables.add(editorPanes.registerEditorPane(descriptor));
	const editorServices = disposables.add(createTestEditorServices(undefined, services));
	const editor = disposables.add(editorServices.createInstance(EditorPart, root, { registry: editorPanes }));
	editorServices.registerInstance(IEditorPart, editor);
	editorServices.registerInstance(ICommandService, disposables.add(new CommandService(editorServices)));
	editorServices.registerInstance(IEditorService, disposables.add(new BrowserEditorService(editor)));
	const preferences = disposables.add(new PreferencesService(editorServices.get(IEditorService), editorServices.get(IFileTextModelService)));
	services.registerInstance(IPreferencesService, preferences);
	const missingHooks = disposables.add(descriptor.create({ instantiationService: editorServices }));
	assert.throws(() => missingHooks.create(h(ownerDocument, 'div')), /Unknown service: hooksService/);
	missingHooks.dispose();
	services.registerInstance(IHooksService, hooksService);

	await preferences.openSettings();
	const host = root.querySelector<HTMLElement>('.ash-modal-editor-host');
	assert.ok(host);
	assert.equal(host.hidden, false);
	assert.equal(root.querySelector('.ash-modal-editor')?.getAttribute('role'), 'dialog');
	assert.deepEqual(
		[...root.querySelectorAll<HTMLElement>('[data-settings-category-id]')].map(element => element.dataset.settingsCategoryId),
		['general', 'editor'],
	);
	const workbenchGroup = root.querySelector<HTMLElement>('[data-settings-group-id="workbench"]');
	assert.ok(workbenchGroup);
	assert.equal(workbenchGroup.closest('.ash-tree-row')?.getAttribute('aria-expanded'), 'false');
	workbenchGroup.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.deepEqual(
		[...root.querySelectorAll<HTMLElement>('[data-settings-category-id]')].map(element => element.dataset.settingsCategoryId),
		['general', 'appearance', 'layout', 'startup', 'editor'],
	);
	assert.equal(root.querySelector('[data-settings-category-id="general"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="appearance"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="layout"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="startup"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-target-id="appearance.group.theme"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="layout.group.layout"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="startup.group.startup-windows"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="startup.group.startup-editor"]'), null);
	const agentsGroup = root.querySelector<HTMLElement>('[data-settings-group-id="agents"]');
	assert.ok(agentsGroup);
	assert.equal(agentsGroup.textContent, 'Chat');
	assert.equal(agentsGroup.closest('.ash-tree-row')?.getAttribute('aria-expanded'), 'false');
	assert.equal(root.querySelector('[data-settings-category-id="models"]'), null);
	assert.ok(root.querySelector(`[data-settings-item-id="${AccessibilityConfiguration.underlineLinks}"]`));
	assert.ok(root.querySelector(`[data-settings-item-id="${HoverConfiguration.delay}"]`));
	const languageControl = root.querySelector<HTMLElement>('[data-configuration-key="workbench.locale"] [role="combobox"]');
	assert.ok(languageControl);
	assert.equal(languageControl.textContent, 'English');
	availableLocales.push({ locale: 'fr', languageName: 'French', localizedLanguageName: 'Français', source: 'marketplace' });
	languagePacksChanged.fire();
	languageControl.click();
	const languageListId = languageControl.getAttribute('aria-controls')!;
	const languageOptions = [...ownerDocument.getElementById(languageListId)!.querySelectorAll<HTMLElement>('[role="option"]')];
	assert.deepEqual(languageOptions.map(option => option.textContent), ['English', '简体中文', 'Français']);
	languageOptions[2].click();
	await nextTurn();
	assert.equal(configuration.getValue(LocalizationConfiguration.locale), 'fr');
	assert.equal(languageControl.textContent, 'Français');
	availableLocales.pop();
	languagePacksChanged.fire();
	assert.equal(languageControl.textContent, 'English');
	await configuration.updateValue(LocalizationConfiguration.locale, 'zh-CN');
	assert.equal(languageControl.textContent, '简体中文');
	assert.equal(languageControl.getAttribute('aria-label'), '界面语言');
	root.querySelector<HTMLButtonElement>('[data-settings-item-id="workbench.locale"] .ash-setting-item-actions-trigger')!.click();
	await menuActions.find(action => action.id === 'settings.resetSetting')!.run();
	hideMenu?.(false);
	assert.equal(languageControl.textContent, 'English');
	assert.equal(configuration.inspect(LocalizationConfiguration.locale).userValue, undefined);
	const autofetchControl = root.querySelector<HTMLElement>(`[data-configuration-key="${GitConfiguration.autofetch}"]`);
	assert.ok(autofetchControl);
	const autofetchButton = autofetchControl.querySelector<HTMLButtonElement>('[role="combobox"]');
	assert.equal(autofetchButton?.getAttribute('aria-label'), 'Auto Fetch');
	const autofetchListId = autofetchButton?.getAttribute('aria-controls');
	assert.ok(autofetchListId);
	autofetchButton?.click();
	ownerDocument.getElementById(autofetchListId)?.querySelectorAll<HTMLElement>('[role="option"]')[1]?.click();
	await nextTurn();
	assert.equal(autoFetch, true);
	autofetchButton?.click();
	ownerDocument.getElementById(autofetchListId)?.querySelectorAll<HTMLElement>('[role="option"]')[2]?.click();
	await nextTurn();
	assert.equal(autoFetch, 'all');

	const underline = root.querySelector<HTMLInputElement>(`[data-configuration-key="${AccessibilityConfiguration.underlineLinks}"]`);
	assert.ok(underline);
	assert.equal(underline.getAttribute('role'), 'switch');
	assert.equal(underline.getAttribute('aria-checked'), 'false');
	underline.click();
	await nextTurn();
	assert.equal(configuration.getValue(AccessibilityConfiguration.underlineLinks), true);
	assert.equal(underline.getAttribute('aria-checked'), 'true');
	const underlineIndicator = root.querySelector<HTMLElement>(`[data-settings-item-id="${AccessibilityConfiguration.underlineLinks}"] .ash-settings-indicators`);
	assert.equal(underlineIndicator?.hidden, true);
	assert.equal(underlineIndicator?.textContent, '');

	const hoverDelay = root.querySelector<HTMLInputElement>(`[data-configuration-key="${HoverConfiguration.delay}"]`);
	assert.ok(hoverDelay);
	hoverDelay.value = '750';
	hoverDelay.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.equal(configuration.getValue(HoverConfiguration.delay), 750);

	root.querySelector<HTMLButtonElement>(`[data-settings-item-id="${HoverConfiguration.delay}"] .ash-setting-item-actions-trigger`)?.click();
	const copyAction = menuActions.find(action => action.id === 'settings.copySettingId');
	const resetAction = menuActions.find(action => action.id === 'settings.resetSetting');
	assert.ok(copyAction);
	assert.ok(resetAction);
	await copyAction.run();
	assert.deepEqual(copied, [HoverConfiguration.delay]);
	await resetAction.run();
	assert.equal(configuration.getValue(HoverConfiguration.delay), configurationRegistry.getConfiguration(HoverConfiguration.delay)?.defaultValue);

	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.equal(root.querySelector('[data-tree-id="group.agents"]')?.getAttribute('aria-expanded'), 'true');
	assert.deepEqual(
		['agents', 'teams', 'agent-defaults', 'models', 'rules', 'skills', 'tools', 'sandbox', 'hooks']
			.map(categoryId => root.querySelector<HTMLElement>(`[data-settings-category-id="${categoryId}"]`)?.textContent),
		['Agents', 'Teams', 'Defaults', 'Models', 'Rules', 'Skills', 'Tools', 'Sandbox', 'Hooks'],
	);
	assert.equal(root.querySelector('[data-tree-id="general"]')?.getAttribute('aria-selected'), 'true');
	root.querySelector<HTMLElement>('[data-settings-category-id="agents"]')?.click();
	await nextTurn();
	assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Agents');
	const advisorSwitch = root.querySelector<HTMLInputElement>('.ash-advisor-settings input[role="switch"]');
	assert.ok(advisorSwitch);
	assert.equal(advisorSwitch.checked, true);
	advisorSwitch.checked = false;
	advisorSwitch.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.deepEqual(advisorWrites, [{ model: advisorModel, enabled: false, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' }]);
	root.querySelector<HTMLElement>('.ash-advisor-settings [aria-haspopup="menu"]')?.click();
	const otherAdvisorOption = [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(option => option.textContent === 'Muse Spark 1.3');
	assert.ok(otherAdvisorOption);
	otherAdvisorOption.click();
	await nextTurn();
	assert.deepEqual(advisorWrites[1], { model: otherAdvisorModel, enabled: true, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' });
	rejectAdvisorSave = true;
	advisorSwitch.checked = false;
	advisorSwitch.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.equal(advisorSwitch.checked, true);
	assert.match(root.querySelector('.ash-advisor-settings [role="status"]')?.textContent ?? '', /Preference write failed/u);
	rejectAdvisorSave = false;
	advisorSwitch.checked = true;
	advisorSwitch.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	root.querySelector<HTMLElement>('.ash-advisor-settings [aria-haspopup="menu"]')?.click();
	const clearAdvisorOption = [...root.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(option => option.textContent === 'Disable');
	assert.ok(clearAdvisorOption);
	clearAdvisorOption.click();
	await nextTurn();
	assert.deepEqual(advisorWrites[3], { model: otherAdvisorModel, enabled: false, maxCalls: 5, maxOutputTokens: 4096, reasoningEffort: 'high' });
	assert.equal(advisorSwitch.checked, false);
	assert.equal(advisorSwitch.disabled, false);
	advisorSwitch.checked = true;
	advisorSwitch.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	hiddenAdvisors.add(otherAdvisorModel.model);
	modelsChanged.fire();
	await nextTurn();
	assert.equal(root.querySelector('.ash-advisor-settings [aria-haspopup="menu"]')?.textContent, 'Muse Spark 1.3');
	root.querySelector<HTMLElement>('.ash-advisor-settings [aria-haspopup="menu"]')?.click();
	assert.deepEqual([...root.querySelectorAll('[role="menuitemradio"]')].map(option => option.textContent), ['Disable', 'GPT-6.1 Sol']);
	assert.equal(advisorWrites.length, 5, 'Hiding a model must not change the saved preference');
	assert.ok(root.querySelector('.ash-advisor-settings.ash-settings-card'));
	assert.equal(root.querySelector('.ash-advisor-settings')?.textContent?.includes('Refresh'), false);
	root.querySelector<HTMLElement>('[data-settings-category-id="tools"]')?.click();
	await nextTurn();
	assert.match(root.querySelector('.ash-agent-capabilities-settings')?.textContent ?? '', /read_file/);
	root.querySelector<HTMLElement>('[data-settings-category-id="sandbox"]')?.click();
	await nextTurn();
	assert.match(root.querySelector('.ash-agent-capabilities-settings')?.textContent ?? '', /\/workspace/);
	root.querySelector<HTMLElement>('[data-settings-category-id="tools"]')?.click();
	await nextTurn();
	assert.equal(capabilityReads, 3);
	connectionChanged.fire('disconnected');
	assert.equal(root.querySelector('.ash-agent-capabilities-status')?.textContent, 'App Server is disconnected.');
	assert.equal(root.querySelector('.ash-agent-capabilities-list'), null);
	connectionChanged.fire('connected');
	await nextTurn();
	assert.equal(capabilityReads, 4);
	assert.match(root.querySelector('.ash-agent-capabilities-settings')?.textContent ?? '', /read_file/);
	root.querySelector<HTMLElement>('[data-settings-category-id="hooks"]')?.click();
	await nextTurn();
	const hooksRoot = root.querySelector<HTMLElement>('.ash-hooks-settings');
	assert.ok(hooksRoot && !hooksRoot.hidden);
	assert.equal(hooksRoot.querySelectorAll('[data-hook-event]').length, 33, hooksRoot.outerHTML);
	assert.equal(hooksRoot.querySelector('[data-hook-event="preToolUse"] > summary')?.textContent, 'PreToolUse · 1 configured');
	assert.equal(root.querySelectorAll('input[type="search"]').length, 1);
	await configuration.updateValue(LocalizationConfiguration.locale, 'zh-CN');
	assert.equal(hooksRoot.querySelector('[data-hook-action="edit-scope"]')?.textContent, '编辑 TOML');
	await configuration.updateValue(LocalizationConfiguration.locale, 'en');
	assert.match(hooksRoot.querySelector('[data-hook-id="user:hook:check"]')?.textContent ?? '', /Disabled.*Source file.*\/profile\/config.toml.*two words/s);
	const hookSearch = root.querySelector<HTMLInputElement>('.ash-settings-search input');
	assert.ok(hookSearch);
	hookSearch.value = 'two words';
	hookSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.deepEqual([...hooksRoot.querySelectorAll<HTMLElement>('.ash-hooks-event')].filter(row => !row.hidden).map(row => row.dataset.hookEvent), ['preToolUse']);
	hooksRoot.querySelector<HTMLElement>('summary')?.focus();
	const contentProvider = AccessibleViewRegistry.getImplementations().find(provider => provider.name.startsWith('hooks-settings-') && provider.type === AccessibleViewType.View)?.getProvider(editorServices);
	assert.ok(contentProvider);
	assert.match(contentProvider.provideContent(), /user:hook:check/);
	contentProvider.dispose();
	hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="edit-scope"]')?.click();
	await nextTurn();
	assert.equal(openUserToml, 1);
	hookSearch.value = '';
	hookSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	sources = [{ namespace: 'user', configPath: '/profile/config.toml', hooks: [] }];
	hooksChanged.fire();
	await nextTurn();
	assert.equal(hookReads, 2);
	assert.equal(hooksRoot.querySelectorAll('.ash-hooks-declaration').length, 0);
	const pendingHooks = new DeferredPromise<readonly HookSource[]>();
	nextHooksRead = pendingHooks.p;
	hooksChanged.fire();
	root.querySelector<HTMLElement>('[data-settings-category-id="models"]')?.click();
	await pendingHooks.complete([{ namespace: 'user', configPath: '/stale/config.toml', hooks: [] }]);
	await nextTurn();
	assert.equal(hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="edit-scope"]')?.title, '/profile/config.toml');
	root.querySelector<HTMLElement>('[data-settings-category-id="hooks"]')?.click();
	await nextTurn();
	assert.equal(hookReads, 4);
	assert.doesNotMatch(hooksRoot.textContent ?? '', /\/stale\/config.toml/);
	hooksFailure = true;
	hooksChanged.fire();
	await nextTurn();
	assert.match(hooksRoot.querySelector('[role="status"]')?.textContent ?? '', /Invalid TOML/);
	const userTomlButton = hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="edit-scope"]');
	assert.ok(userTomlButton && !userTomlButton.disabled);
	userTomlButton.click();
	await nextTurn();
	assert.equal(openUserToml, 2);
	hooksFailure = false;
	connectionIdentity = { kind: 'ssh', host: 'test-server', authority: 'ssh+test-server', generation: 2 };
	connectionIdentityChanged.fire(connectionIdentity);
	await nextTurn();
	assert.equal(userTomlButton.disabled, true);
	connectionIdentity = { kind: 'local', generation: 3 };
	connectionIdentityChanged.fire(connectionIdentity);
	await nextTurn();
	assert.equal(userTomlButton.disabled, false);

	hookSearch.value = '';
	hookSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	hooksRoot.querySelector<HTMLButtonElement>('[data-hook-action="ask-scope"]')?.click();
	await nextTurn();
	assert.equal(host.hidden, true);
	assert.match(prompts[0] ?? '', /\/profile\/config.toml.*namespace \(user\)/);
	await preferences.openSettings();
	await preferences.openSettings('dictation');
	assert.equal(root.querySelector('[data-settings-container]')?.getAttribute('data-active-settings-category'), 'general');
	assert.equal(root.querySelector('[data-tree-id="general"]')?.getAttribute('aria-selected'), 'true');
	assert.equal(root.querySelector('[data-settings-category-id="dictation"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id]'), null);
	assert.equal(root.querySelector('[data-settings-tree-group-id="dictation"] .ash-settings-tree-group-title')?.textContent, 'Voice input');
	await configuration.updateValue(LocalizationConfiguration.locale, 'zh-CN');
	assert.equal(root.querySelector('[data-settings-tree-group-id="dictation"] .ash-settings-tree-group-title')?.textContent, '语音输入');
	const dictationSearch = root.querySelector<HTMLInputElement>('.ash-settings-search input')!;
	dictationSearch.value = '听写';
	dictationSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.ok(root.querySelector('[role="grid"][aria-label="Local dictation models"]'));
	assert.ok(root.querySelector('[data-settings-category-id="general"]'));
	dictationSearch.value = '';
	dictationSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	await configuration.updateValue(LocalizationConfiguration.locale, 'en');
	assert.equal(root.querySelector('[data-configuration-key="dictation.localModel"]'), null);
	assert.ok(root.querySelector('[role="grid"][aria-label="Local dictation models"]'));
	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.click();
	root.querySelector<HTMLElement>('[data-settings-category-id="models"]')?.click();
	await nextTurn();
	assert.equal(root.querySelector('[data-settings-container]')?.getAttribute('data-active-settings-category'), 'models');
	assert.equal(root.querySelector('[data-configuration-key="dictation.localModel"]'), null);
	const modelSwitch = root.querySelector<HTMLInputElement>('.ash-models-settings-model-row input[role="switch"]');
	assert.ok(modelSwitch);
	assert.equal(modelSwitch.getAttribute('aria-label'), 'Show GPT Test in model picker');
	modelSwitch.click();
	await nextTurn();
	assert.deepEqual(modelWrites, [false]);
	assert.equal(modelSwitch.getAttribute('aria-checked'), 'false');
	const modelSearch = root.querySelector<HTMLInputElement>('.ash-settings-search input');
	assert.ok(modelSearch);
	modelSearch.value = 'missing';
	modelSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('.ash-models-settings-model-row'), null);
	modelSearch.value = '';
	modelSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const apiInput = root.querySelector<HTMLInputElement>('.ash-models-settings-api-controls input[type="password"]');
	assert.ok(apiInput);
	assert.equal(apiInput.closest('.ash-models-settings-api-controls')?.querySelector('button'), null);
	apiInput.value = 'test-secret';
	apiInput.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	apiInput.dispatchEvent(new browserEnvironment.window.Event('blur'));
	await nextTurn();
	assert.deepEqual(savedKeys, ['test-secret']);
	assert.equal(root.textContent?.includes('test-secret'), false);
	root.querySelector<HTMLElement>('[data-settings-category-id="teams"]')?.click();
	assert.equal(root.querySelector<HTMLElement>('[data-settings-container]')?.dataset.activeSettingsCategory, 'teams');
	assert.equal(root.querySelector('.ash-settings-page h3')?.textContent, 'Teams');
	assert.equal(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length, 0);
	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.equal(root.querySelector('[data-tree-id="group.agents"]')?.getAttribute('aria-selected'), 'true');
	root.querySelector<HTMLElement>('[data-settings-group-id="agents"]')?.closest<HTMLElement>('.ash-tree-row')?.click();
	assert.equal(root.querySelector('[data-tree-id="teams"]')?.getAttribute('aria-selected'), 'true');

	const search = root.querySelector<HTMLInputElement>('.ash-settings-search input');
	assert.ok(search);
	search.value = 'subagent';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('[data-settings-category-id="agents"]')?.textContent, 'Agents');
	assert.equal(root.querySelector('[data-settings-category-id="teams"]'), null);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
	assert.equal(search.value, '');
	search.value = 'workbench.colorTheme';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('[data-settings-category-id="appearance"]')?.textContent, 'Appearance');
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));

	root.querySelector<HTMLElement>('[data-settings-category-id="editor"]')?.click();
	assert.equal(root.querySelector<HTMLElement>('[data-settings-container]')?.dataset.activeSettingsCategory, 'editor');
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.ok(root.querySelector(`[data-configuration-key="${EditorSelectionConfiguration.defaultNewDocumentEditor}"]`));
	assert.equal(root.querySelector('[data-settings-item-id^="models.item."]'), null);
	const fontFamily = root.querySelector<HTMLInputElement>(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`);
	assert.ok(fontFamily);
	fontFamily.value = 'Fira Code';
	fontFamily.dispatchEvent(new browserEnvironment.window.Event('change', { bubbles: true }));
	await nextTurn();
	assert.equal(configuration.getValue(CodeEditorConfiguration.fontFamily), 'Fira Code');
	root.querySelector<HTMLButtonElement>('.ash-settings-search-filter')?.click();
	assert.deepEqual(menuActions.filter(action => action.label).map(action => action.label), ['Setting ID…', 'Clear Filters']);
	const idFilter = menuActions.find(action => action.id === 'settings.search.id');
	assert.ok(idFilter);
	await idFilter.run();
	hideMenu?.(false);
	assert.equal(search.value, '@id:');
	search.value = '@id:fontFamily';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontSize}"]`), null);
	root.querySelector<HTMLButtonElement>('.ash-settings-search-filter')?.click();
	const clearFilters = menuActions.find(action => action.id === 'settings.search.clearFilters');
	assert.ok(clearFilters);
	assert.equal(clearFilters.enabled, true);
	await clearFilters.run();
	hideMenu?.(false);
	assert.equal(search.value, '');

	search.value = 'font family';
	search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length, 1);
	assert.ok(root.querySelector(`[data-settings-item-id="${CodeEditorConfiguration.fontFamily}"]`));
	assert.equal(root.querySelector(`[data-configuration-key="${CodeEditorConfiguration.fontFamily}"]`), fontFamily);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' }));
	assert.equal(root.querySelector('.ash-settings-navigation-tree')?.contains(ownerDocument.activeElement), true);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
	assert.equal(search.value, '');
	assert.ok(root.querySelectorAll('.ash-settings-content-tree [data-settings-item-id]').length > 1);
	await preferences.openSettings('models');
	assert.equal(root.querySelector<HTMLElement>('[data-settings-container]')?.dataset.activeSettingsCategory, 'models');

	root.querySelector<HTMLButtonElement>('.ash-modal-editor-close')?.click();
	await nextTurn();
	assert.equal(host.hidden, true);
	assert.equal(ownerDocument.activeElement, trigger);
});

function findSettingCategory(layout: ReturnType<typeof createSettingsLayout>, settingId: string): string | undefined {
	return layout.find(category => category.groups.some(group => group.settings.some(setting => setting.id === settingId)))?.id;
}

async function nextTurn(): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, 0));
}

test('Local model controls share translated snapshots and keep preparation running when hidden', async () => {
	using resources = new DisposableStore();
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	resources.add(toDisposable(resetNlsResolver));
	const configuration = resources.add(new WorkbenchConfigurationService());
	await configuration.updateValue(DictationConfiguration.localModel, 'imported-model');
	const services = resources.add(new InstantiationService());
	services.registerInstance(ConfigurationServiceId, configuration);
	const changed = resources.add(new Emitter<void>());
	let modelStatus: ILocalTranscriptionModelStatus | undefined;
	const progress = (status: ILocalTranscriptionModelStatus): void => { modelStatus = status; changed.fire(); };
	let finish!: (state: ModelState.Cancelled) => void;
	let cancellations = 0;
	const imported: unknown[] = [];
	services.registerInstance(ILocalTranscriptionService, {
		isSupported: true,
		getModelStatus: async (model: string) => ({ model, available: false, sizeBytes: 0, status: modelStatus }),
		listModels: async () => [],
		onDidChangeModels: changed.event,
		cancelModel: async () => { cancellations++; progress({ state: LocalTranscriptionModelState.Cancelled }); finish(LocalTranscriptionModelState.Cancelled); },
		importModel: (options: unknown, onProgress: typeof progress) => {
			imported.push(options);
			progress({ state: LocalTranscriptionModelState.Checking });
			return {
				completed: new Promise<ModelState.Cancelled>(resolve => { finish = resolve; }),
				cancel: async () => { cancellations++; progress({ state: LocalTranscriptionModelState.Cancelled }); finish(LocalTranscriptionModelState.Cancelled); },
				dispose() {},
			};
		},
	} as unknown as LocalTranscriptionService);
	const root = h(browserEnvironment.window.document, 'div');
	const controls = resources.add(services.createInstance(LocalTranscriptionModelControls, root));
	controls.setVisible(true);
	await nextTurn();
	const status = root.querySelector<HTMLElement>('[role="status"]')!;
	assert.equal(status.textContent, '模型包尚未安装：imported-model');
	const source = root.querySelector<HTMLInputElement>('input')!;
	assert.equal(source.getAttribute('aria-label'), '已准备好的 Paraformer 模型目录');
	assert.equal(root.querySelector('label')?.htmlFor, source.id);
	source.value = 'C:\\prepared-model';
	source.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const buttons = [...root.querySelectorAll<HTMLButtonElement>('button')];
	const importButton = buttons.find(button => button.textContent === '导入模型')!;
	assert.equal(importButton.disabled, false);
	importButton.click();
	assert.deepEqual(imported, [{ model: 'imported-model', sourcePath: 'C:\\prepared-model' }]);
	assert.equal(importButton.disabled, true);
	progress({ state: LocalTranscriptionModelState.Downloading, file: 'encoder.onnx', downloadedBytes: 2 * 1024 * 1024 });
	await nextTurn();
	assert.equal(status.textContent, '正在下载 encoder.onnx：2.0 MiB');
	assert.equal(status.getAttribute('aria-atomic'), 'true');
	controls.setVisible(false);
	await nextTurn();
	assert.equal(cancellations, 0);
	controls.setVisible(true);
	await nextTurn();
	assert.equal(root.querySelector<HTMLProgressElement>('progress')?.hasAttribute('value'), false);
	buttons.find(button => button.textContent === '取消')!.click();
	await nextTurn();
	assert.equal(cancellations, 1);
	assert.equal(importButton.disabled, false);
	assert.equal(buttons.find(button => button.textContent === '取消')?.classList.contains('hidden'), true);
});

test('Models Settings collapses by provider and saves keys and custom models on blur', async () => {
	using disposables = new DisposableStore();
	const document = browserEnvironment.window.document;
	document.body.replaceChildren();
	const root = h(document, 'div');
	document.body.append(root);
	const saved: import('../../../../../platform/sessions/common/sessionApi.js').CustomModelProvider[] = [];
	const keys: string[] = [];
	let removed = 0;
	let failed = false;
	let rejectKey = false;
	const model = { provider: 'openai', model: 'newest' };
	const chat = {
		onDidChangeModels: Event.None,
		listModelCatalog: async () => [
			{ model, displayName: 'Newest OpenAI' },
			{ model: { provider: 'openai', model: 'older' }, displayName: 'Older OpenAI' },
			{ model: { provider: 'anthropic', model: 'opus' }, displayName: 'Opus' },
		],
		listModelProviders: async () => ['openai', 'qwen', 'openai-compatible', 'huggingface'].map(connection => ({ connection, provider: connection, displayName: connection, apiKeyPolicy: 'required', apiKeyConfigured: true })),
		listCustomModelProviders: async () => [],
		isModelVisible: () => true,
		saveCustomModelProvider: async (provider: typeof saved[number]) => { saved.push(provider); },
		setModelProviderApiKey: async (_id: string, key: string) => { if (rejectKey) throw new Error('Key write rejected'); keys.push(key); },
		removeModelProviderApiKey: async () => { removed++; },
		refreshModels: async () => [],
		testProviderModel: async () => failed ? { type: 'failed', message: 'Endpoint rejected this model' } : { type: 'passed' },
	} as unknown as IChatService;
	const configuration = disposables.add(new WorkbenchConfigurationService());
	const services = disposables.add(new InstantiationService());
	services.registerInstance(ChatServiceId, chat);
	services.registerInstance(INotificationService, disposables.add(new NotificationService()));
	services.registerInstance(ILanguageModelsService, chat as unknown as ILanguageModelsService);
	services.registerInstance(IContextViewService, disposables.add(new BrowserContextViewService(root)));
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IAccessibleViewService, { show: () => true, getOpenAriaHint: () => undefined, dispose() {}, [Symbol.dispose]() {} });
	const content = disposables.add(services.createInstance(ModelSettingsContent, root));
	const modelTree = disposables.add(new SettingsTreeModel<SettingsContentItem>());
	disposables.add(new SettingsTree(root, { model: modelTree, rootClassName: 'ash-models-settings', groupClassName: 'ash-settings-content-group', groupDescriptionClassName: 'ash-settings-group-description', itemsClassName: 'ash-settings-list', renderItem: item => item.value.domNode }));
	disposables.add(content.onDidChange(() => modelTree.setChildren([{ element: { kind: 'group', id: 'models', title: 'Models', description: '' }, children: content.getNodes() }])));
	content.setVisible(true);
	await nextTurn();
	assert.deepEqual([...root.querySelectorAll('.ash-models-settings-model-copy')].map(row => row.textContent), ['Newest OpenAI', 'Opus']);
	const expand = root.querySelector<HTMLButtonElement>('.ash-models-settings-expand button')!;
	expand.click();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 3);
	assert.equal(expand.getAttribute('aria-expanded'), 'true');
	expand.click();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 2);
	assert.equal(content.getNodes(new SettingsSearchQuery('Older')).flatMap(node => node.children ?? []).some(node => node.element.kind === 'item' && node.element.title === 'Older OpenAI'), true);
	const search = root.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
	const searchModels = (value: string): void => {
		search.value = value;
		search.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	};
	search.focus();
	searchModels('OPENAI/OLDER');
	assert.deepEqual([...root.querySelectorAll('.ash-models-settings-model-copy')].map(row => row.textContent), ['Older OpenAI']);
	assert.equal(document.activeElement, search);
	assert.equal(root.querySelectorAll('.ash-models-settings-api-row').length, 1);
	searchModels('missing model');
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 0);
	assert.match(root.textContent ?? '', /No models found/);
	assert.equal(document.activeElement, search);
	searchModels('');
	assert.deepEqual([...root.querySelectorAll('.ash-models-settings-model-copy')].map(row => row.textContent), ['Newest OpenAI', 'Opus']);
	assert.equal(root.querySelectorAll('.ash-models-settings-api-row').length, 1);
	const input = root.querySelector<HTMLInputElement>('.ash-models-settings-api-row input')!;
	const edit = (field: HTMLInputElement, value: string): void => {
		field.value = value;
		field.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
		field.dispatchEvent(new browserEnvironment.window.Event('blur'));
	};
	input.dispatchEvent(new browserEnvironment.window.Event('blur'));
	await nextTurn();
	assert.deepEqual(keys, []);
	assert.equal(removed, 0, 'An untouched masked key must not be removed');
	edit(input, 'new-test-key');
	await nextTurn();
	assert.deepEqual(keys, ['new-test-key']);
	assert.equal(input.value, '••••••••');
	edit(input, '');
	await nextTurn();
	assert.equal(removed, 1);
	rejectKey = true;
	edit(input, 'retry-test-key');
	await nextTurn();
	assert.equal(input.getAttribute('aria-invalid'), 'true');
	assert.equal(input.value, 'retry-test-key');
	rejectKey = false;
	input.dispatchEvent(new browserEnvironment.window.Event('blur'));
	await nextTurn();
	assert.equal(input.value, '••••••••');
	assert.equal(input.hasAttribute('aria-invalid'), false);
	root.querySelector<HTMLButtonElement>('.ash-models-settings-provider-title button')!.click();
	const card = root.querySelector<HTMLElement>('.ash-chat-models-widget')!;
	assert.equal(document.activeElement, card.querySelector('input'));
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Provider name"]')!, 'Gateway');
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!, 'https://example.test/v1');
	await nextTurn();
	const button = (label: string): HTMLButtonElement => [...card.querySelectorAll<HTMLButtonElement>('button')].find(candidate => candidate.textContent === label)!;
	button('Add model').click();
	const first = card.querySelector<HTMLInputElement>('input[aria-label="Model ID"]')!;
	edit(first, 'first-private-model');
	card.querySelector<HTMLInputElement>('input[role="switch"][aria-label="1M context"]')!.click();
	button('Save model').click();
	await nextTurn();
	button('Add model').click();
	edit(first, 'second-private-model');
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Context window (tokens)"]')!, '128000');
	button('Save model').click();
	await nextTurn();
	assert.deepEqual(saved.at(-1)?.models, [{ id: 'first-private-model', contextWindow: 1_000_000 }, { id: 'second-private-model', contextWindow: 128_000 }]);
	const testButton = button('Test models');
	testButton.click();
	await nextTurn();
	assert.equal(card.querySelector('.ash-chat-models-test-status')?.classList.contains('passed'), true);
	edit(card.querySelector<HTMLInputElement>('input[aria-label="Base URL"]')!, 'https://another.test/v1');
	await nextTurn();
	assert.equal(card.querySelector('.ash-chat-models-test-status')?.classList.contains('passed'), false);
	failed = true;
	testButton.click();
	await nextTurn();
	assert.match(card.textContent ?? '', /Endpoint rejected this model/);
	button('Add model').click();
	first.focus();
	const help = AccessibleViewRegistry.getImplementations().find(provider => provider.name.startsWith('models-settings-'))?.getProvider(services);
	assert.match(help?.provideContent() ?? '', /clear the field to remove a key/);
	help?.dispose();
});

test('Custom provider fields and test states use the Chinese catalog', () => {
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		assert.equal(localize('models.catalog.search', 'Search models'), '搜索模型');
		assert.equal(localize('models.provider.name', 'Provider name'), '供应商名称');
		assert.equal(localize('models.provider.context', '1M context'), '1M 上下文');
		assert.equal(localize('models.provider.passed', 'Model test passed'), '模型测试通过');
		assert.equal(localize('models.discovery.unsupported', 'This endpoint does not provide a model list. Add model IDs manually.'), '此端点不提供模型列表，请手动添加模型 ID。');
		assert.equal(localize('models.provider.contextWindow', 'Context window (tokens)'), '上下文长度（tokens）');
	} finally { resetNlsResolver(); }
});
