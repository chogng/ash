import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../../../base/common/actions.js';
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IContextMenuService as ContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { ILocalizationService } from '../../../../../workbench/services/localization/common/localizationService.js';
import type { IGitService } from '../../../../../workbench/services/git/common/gitService.js';
import type { IChatService } from '../../../../../workbench/services/chat/common/chatService.js';

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
const { DisposableStore } = await import('../../../../../base/common/lifecycle.js');
const { ConfigurationRegistry, Extensions: ConfigurationExtensions } = await import('../../../../../platform/configuration/common/configurationRegistry.js');
const { IClipboardService: ClipboardServiceId } = await import('../../../../../platform/clipboard/common/clipboardService.js');
const { IConfigurationService: ConfigurationServiceId } = await import('../../../../../platform/configuration/common/configuration.js');
const { IContextMenuService } = await import('../../../../../platform/contextview/browser/contextView.js');
const { IContextViewService } = await import('../../../../../platform/contextview/browser/contextView.js');
const { BrowserContextViewService } = await import('../../../../../platform/contextview/browser/contextViewService.js');
const { ServiceContainer, ServiceConstructionDescriptor } = await import('../../../../../platform/instantiation/common/instantiation.js');
const { Registry } = await import('../../../../../platform/registry/common/platform.js');
const { darkColorTheme } = await import('../../../../../platform/theme/common/colorTheme.js');
const { AccessibilityConfiguration } = await import('../../../../../platform/accessibility/common/accessibility.js');
const { HoverConfiguration } = await import('../../../../../platform/hover/common/hoverService.js');
const { SashConfiguration } = await import('../../../../../workbench/contrib/sash/common/sash.js');
const { DictationConfiguration } = await import('../../../../../platform/dictation/common/dictationConfiguration.js');
const { WorkbenchConfiguration } = await import('../../../../../workbench/common/configuration.js');
const { SessionsConfiguration } = await import('../../../../../sessions/common/configuration.js');
const { WorkbenchThemesRegistry } = await import('../../../../../workbench/common/theme.js');
const { EditorSelectionConfiguration } = await import('../../../../../workbench/common/editorSelectionConfiguration.js');
const { CodeEditorConfiguration } = await import('../../../../../workbench/contrib/codeEditor/common/editorConfiguration.js');
const { ContentSearchConfiguration } = await import('../../../../../workbench/contrib/search/common/searchConfiguration.js');
const { GitConfiguration } = await import('../../../../../workbench/services/git/common/gitConfiguration.js');
const { ScmConfiguration } = await import('../../../../../workbench/contrib/scm/common/scmConfiguration.js');
const { IGitService: GitServiceId } = await import('../../../../../workbench/services/git/common/gitService.js');
const { IChatService: ChatServiceId } = await import('../../../../../workbench/services/chat/common/chatService.js');
const configurationRegistry = Registry.as<InstanceType<typeof ConfigurationRegistry>>(ConfigurationExtensions.Configuration);
const { EditorPart } = await import('../../../../../workbench/browser/parts/editor/editorPart.js');
const { EditorPaneMatch } = await import('../../../../../workbench/browser/parts/editor/editorPane.js');
const { EditorPaneRegistry } = await import('../../../../../workbench/browser/parts/editor/editorRegistry.js');
const { SettingsSearchQuery } = await import('../../../../../workbench/contrib/preferences/browser/settingsSearch.js');
const { createSettingsLayout, SettingsCategories, SettingsLayout } = await import('../../../../../workbench/contrib/preferences/browser/settingsLayout.js');
const { SettingsEditor, SettingsEditorId } = await import('../../../../../workbench/contrib/preferences/browser/settingsEditor.js');
const { ModelsSettings } = await import('../../../../../workbench/contrib/preferences/browser/modelsSettings.js');
const { SettingsTree } = await import('../../../../../workbench/contrib/preferences/browser/settingsTree.js');
const { SettingsTreeModel } = await import('../../../../../workbench/contrib/preferences/browser/settingsTreeModels.js');
const { PreferencesService } = await import('../../../../../workbench/services/preferences/browser/preferencesService.js');
const { BrowserEditorService } = await import('../../../../../workbench/services/editor/browser/browserEditorService.js');
const { ILocalizationService: LocalizationServiceId } = await import('../../../../../workbench/services/localization/common/localizationService.js');
const { isSettingsEditorInput } = await import('../../../../../workbench/services/preferences/common/settingsEditorInput.js');
const { DefaultSettings, SettingsEditorModel } = await import('../../../../../workbench/services/preferences/common/settingsModels.js');
const { WorkbenchConfigurationService } = await import('../../../../../workbench/services/configuration/browser/configurationService.js');
const { builtinLanguagePackCatalogs } = await import('../../../../../workbench/services/localization/common/localizationCatalogs.js');
const { StartupEditorConfigurationKey } = await import('../../../../../workbench/contrib/welcomeGettingStarted/browser/startupPage.js');
await import('../../../../../workbench/contrib/welcomeGettingStarted/browser/gettingStarted.contribution.js');
await import('../../../../../workbench/browser/workbench.contribution.js');
await import('../../../../../workbench/electron-browser/desktop.contribution.js');

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
		'tools-and-mcps',
		'hooks',
	]);
	assert.deepEqual(model.settings.map(setting => setting.id), defaults.all.map(setting => setting.id));
	assert.equal(findSettingCategory(layout, AccessibilityConfiguration.underlineLinks), 'general');
	assert.equal(findSettingCategory(layout, HoverConfiguration.delay), 'general');
	assert.equal(findSettingCategory(layout, SashConfiguration.size), 'general');
	assert.equal(findSettingCategory(layout, DictationConfiguration.backend), 'general');
	assert.equal(findSettingCategory(layout, DictationConfiguration.localModel), 'general');
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.colorTheme), 'appearance');
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.layoutStyle), 'layout');
	assert.equal(findSettingCategory(layout, StartupEditorConfigurationKey), 'startup');
	assert.equal(findSettingCategory(layout, 'window.restoreWindows'), 'startup');
	assert.equal(findSettingCategory(layout, 'workbench.editor.restoreEditors'), 'startup');
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.equal(chinese?.bundles['ash.settings']?.['categories.startup.label'], '启动');
	assert.equal(chinese?.bundles.ash?.['settings.workbench.startup.group.label'], '启动时的编辑器');
	assert.equal(chinese?.bundles.ash?.['window.restoreWindows.all'], '全部窗口');
	assert.equal(chinese?.bundles.ash?.['workbench.editor.restoreEditors.title'], '恢复编辑器');
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
		isModelVisible: () => true,
	} as unknown as IChatService;
	const panel = disposables.add(new ModelsSettings(root, {
		chatService: chat,
		clipboardService: {} as IClipboardService,
		configurationService: configuration,
		contextMenuProvider: {} as ContextMenuService,
		contextViewProvider: contextView,
	}));
	panel.setVisible(true);
	await nextTurn();
	catalog = [{ model, displayName: 'GPT Test Updated' }];
	changed.fire();
	resolveProviders([{ connection: 'openai', provider: 'openai', displayName: 'OpenAI API', apiKeyPolicy: 'required', apiKeyConfigured: false }]);
	await nextTurn();
	assert.equal(root.querySelector('.ash-models-settings-api-row h5')?.textContent, 'OpenAI API');
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
	const chatService = {
		onDidChangeModels: modelsChanged.event,
		listModelCatalog: async () => [{ model, displayName: 'GPT Test' }],
		listModelProviders: async () => [{ connection: 'openai', provider: 'openai', displayName: 'OpenAI API', apiKeyPolicy: 'required', apiKeyConfigured: savedKeys.length > 0 }],
		isModelVisible: () => modelVisible,
		setModelVisible: async (_model: typeof model, visible: boolean) => {
			modelWrites.push(visible);
			modelVisible = visible;
			modelsChanged.fire();
		},
		setModelProviderApiKey: async (_connection: string, key: string) => { savedKeys.push(key); },
		refreshModels: async () => [{ model, displayName: 'GPT Test' }],
	} as unknown as IChatService;
	const contextView = disposables.add(new BrowserContextViewService(root));
	const services = new ServiceContainer();
	services.registerInstance(ClipboardServiceId, clipboardService);
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IContextMenuService, contextMenuProvider);
	services.registerInstance(IContextViewService, contextView);
	services.registerInstance(LocalizationServiceId, localizationService);
	services.registerInstance(GitServiceId, gitService);
	services.registerInstance(ChatServiceId, chatService);
	const instantiationService = services;
	const editorPanes = new EditorPaneRegistry();
	disposables.add(editorPanes.register({
		id: SettingsEditorId,
		name: 'Settings',
		canOpen: input => isSettingsEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => instantiationService.createInstance(new ServiceConstructionDescriptor(SettingsEditor, {
			serviceDependencies: [ClipboardServiceId, ConfigurationServiceId, IContextMenuService, IContextViewService, LocalizationServiceId, GitServiceId, ChatServiceId],
		})),
	}));
	const editor = disposables.add(new EditorPart(root, { registry: editorPanes, instantiationService }));
	const preferences = disposables.add(new PreferencesService(() => new BrowserEditorService(editor)));

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
	assert.equal(root.querySelector('[data-settings-category-id="appearance"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="layout"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-category-id="startup"]')?.closest('.ash-tree-row')?.hasAttribute('aria-expanded'), false);
	assert.equal(root.querySelector('[data-settings-target-id="appearance.group.theme"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="layout.group.layout"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="startup.group.startup-windows"]'), null);
	assert.equal(root.querySelector('[data-settings-target-id="startup.group.startup-editor"]'), null);
	const agentsGroup = root.querySelector<HTMLElement>('[data-settings-group-id="agents"]');
	assert.ok(agentsGroup);
	assert.equal(agentsGroup.textContent, 'Agents');
	assert.equal(agentsGroup.closest('.ash-tree-row')?.getAttribute('aria-expanded'), 'false');
	assert.equal(root.querySelector('[data-settings-category-id="models"]'), null);
	assert.ok(root.querySelector(`[data-settings-item-id="${AccessibilityConfiguration.underlineLinks}"]`));
	assert.ok(root.querySelector(`[data-settings-item-id="${HoverConfiguration.delay}"]`));
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
		['agents', 'teams', 'agent-defaults', 'models', 'rules', 'skills', 'tools-and-mcps', 'hooks']
			.map(categoryId => root.querySelector<HTMLElement>(`[data-settings-category-id="${categoryId}"]`)?.textContent),
		['My Agents', 'Teams', 'Defaults', 'Models', 'Rules', 'Skills', 'Tools & MCPs', 'Hooks'],
	);
	assert.equal(root.querySelector('[data-tree-id="general"]')?.getAttribute('aria-selected'), 'true');
	root.querySelector<HTMLElement>('[data-settings-category-id="models"]')?.click();
	await nextTurn();
	assert.equal(root.querySelector('[data-settings-container]')?.getAttribute('data-active-settings-category'), 'models');
	assert.ok(root.querySelector('[data-configuration-key="dictation.localModel"]'));
	const modelSwitch = root.querySelector<HTMLInputElement>('.ash-models-settings-model-row input[role="switch"]');
	assert.ok(modelSwitch);
	assert.equal(modelSwitch.getAttribute('aria-label'), 'Show GPT Test in model picker');
	modelSwitch.click();
	await nextTurn();
	assert.deepEqual(modelWrites, [false]);
	assert.equal(modelSwitch.getAttribute('aria-checked'), 'false');
	const modelSearch = root.querySelector<HTMLInputElement>('.ash-models-settings-search input');
	assert.ok(modelSearch);
	modelSearch.value = 'missing';
	modelSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	assert.equal(root.querySelector('.ash-models-settings-empty')?.textContent, 'No matching models or APIs.');
	modelSearch.value = '';
	modelSearch.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	const apiInput = root.querySelector<HTMLInputElement>('.ash-models-settings-api-controls input[type="password"]');
	const saveKey = root.querySelector<HTMLButtonElement>('.ash-models-settings-api-controls button');
	assert.ok(apiInput && saveKey);
	apiInput.value = 'test-secret';
	apiInput.dispatchEvent(new browserEnvironment.window.Event('input', { bubbles: true }));
	saveKey.click();
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
	assert.equal(root.querySelector('[data-settings-category-id="agents"]')?.textContent, 'My Agents');
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
