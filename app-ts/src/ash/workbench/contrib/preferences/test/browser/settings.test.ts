import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IAction } from '../../../../../base/common/actions.js';
import type { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import type { IContextMenuService as ContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { ILocalizationService } from '../../../../../workbench/services/localization/common/localizationService.js';
import type { IGitService } from '../../../../../workbench/services/git/common/gitService.js';

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
const { WorkbenchConfiguration } = await import('../../../../../workbench/common/configuration.js');
const { WorkbenchThemesRegistry } = await import('../../../../../workbench/common/theme.js');
const { EditorSelectionConfiguration } = await import('../../../../../workbench/common/editorSelectionConfiguration.js');
const { CodeEditorConfiguration } = await import('../../../../../workbench/contrib/codeEditor/common/editorConfiguration.js');
const { ContentSearchConfiguration } = await import('../../../../../workbench/contrib/search/common/searchConfiguration.js');
const { GitConfiguration } = await import('../../../../../workbench/services/git/common/gitConfiguration.js');
const { ScmConfiguration } = await import('../../../../../workbench/contrib/scm/common/scmConfiguration.js');
const { IGitService: GitServiceId } = await import('../../../../../workbench/services/git/common/gitService.js');
const configurationRegistry = Registry.as<InstanceType<typeof ConfigurationRegistry>>(ConfigurationExtensions.Configuration);
const { EditorPart } = await import('../../../../../workbench/browser/parts/editor/editorPart.js');
const { EditorPaneMatch } = await import('../../../../../workbench/browser/parts/editor/editorPane.js');
const { EditorPaneRegistry } = await import('../../../../../workbench/browser/parts/editor/editorRegistry.js');
const { PreferencesEditor, PreferencesEditorId } = await import('../../../../../workbench/contrib/preferences/browser/preferencesEditor.js');
const { PreferencesEditorPaneRegistry } = await import('../../../../../workbench/contrib/preferences/browser/preferencesEditorRegistry.js');
const { PreferencesSearchQuery } = await import('../../../../../workbench/contrib/preferences/browser/preferencesSearch.js');
const { createSettingsLayout, SettingsCategories, SettingsLayout } = await import('../../../../../workbench/contrib/preferences/browser/settingsLayout.js');
const { SettingsEditorPane, SettingsEditorPaneId } = await import('../../../../../workbench/contrib/preferences/browser/settingsEditor.js');
const { SettingsTree } = await import('../../../../../workbench/contrib/preferences/browser/settingsTree.js');
const { SettingsTreeModel } = await import('../../../../../workbench/contrib/preferences/browser/settingsTreeModels.js');
const { PreferencesService } = await import('../../../../../workbench/services/preferences/browser/preferencesService.js');
const { BrowserEditorService } = await import('../../../../../workbench/services/editor/browser/browserEditorService.js');
const { ILocalizationService: LocalizationServiceId } = await import('../../../../../workbench/services/localization/common/localizationService.js');
const { isPreferencesEditorInput } = await import('../../../../../workbench/services/preferences/common/preferencesEditorInput.js');
const { DefaultSettings, SettingsEditorModel } = await import('../../../../../workbench/services/preferences/common/preferencesModels.js');
const { WorkbenchConfigurationService } = await import('../../../../../workbench/services/configuration/browser/configurationService.js');

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
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.colorTheme), 'appearance');
	assert.equal(findSettingCategory(layout, WorkbenchConfiguration.layoutStyle), 'appearance');
	assert.equal(findSettingCategory(layout, EditorSelectionConfiguration.defaultNewDocumentEditor), 'editor');
	assert.equal(findSettingCategory(layout, 'breadcrumbs.filePath'), 'editor');
	assert.equal(findSettingCategory(layout, 'breadcrumbs.symbolPath'), 'editor');
	assert.equal(findSettingCategory(layout, 'workbench.editorLargeFileConfirmation'), 'editor');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.fontFamily), 'editor');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.renderWhitespace), 'editor');
	assert.equal(findSettingCategory(layout, CodeEditorConfiguration.renderControlCharacters), 'editor');
	assert.equal(findSettingCategory(layout, ContentSearchConfiguration.maxResults), 'editor');
	assert.equal(findSettingCategory(layout, ScmConfiguration.diffDecorationsIgnoreTrimWhitespace), 'general');
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

test('Preferences search normalizes pasted setting syntax and matches complete metadata terms', () => {
	const query = new PreferencesSearchQuery('  "Editor.Font: Family"  ');

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

test('Preferences search composes modified and setting ID filters', () => {
	const modifiedIds = new Set(['editor.fontFamily']);
	const query = new PreferencesSearchQuery('@modified @id:font editor', {
		isModified: id => modifiedIds.has(id),
	});

	assert.equal(query.hasModifiedFilter, true);
	assert.equal(query.matches({ id: 'editor.fontFamily', title: 'Font family', description: 'Editor typography.' }), true);
	assert.equal(query.matches({ id: 'editor.fontSize', title: 'Font size', description: 'Editor typography.' }), false);
	assert.equal(query.matches({ id: 'workbench.fontFamily', title: 'Font family', description: 'Workbench typography.' }), false);
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

test('PreferencesEditor renders and updates registry-backed settings only', async () => {
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
	const contextView = disposables.add(new BrowserContextViewService(root));
	const services = new ServiceContainer();
	services.registerInstance(ClipboardServiceId, clipboardService);
	services.registerInstance(ConfigurationServiceId, configuration);
	services.registerInstance(IContextMenuService, contextMenuProvider);
	services.registerInstance(IContextViewService, contextView);
	services.registerInstance(LocalizationServiceId, localizationService);
	services.registerInstance(GitServiceId, gitService);
	const instantiationService = services;
	const preferencesPanes = disposables.add(new PreferencesEditorPaneRegistry());
	disposables.add(preferencesPanes.registerPreferencesEditorPane({
		id: SettingsEditorPaneId,
		title: 'Settings',
		order: 1,
		ctorDescriptor: new ServiceConstructionDescriptor(SettingsEditorPane, {
			serviceDependencies: [ClipboardServiceId, ConfigurationServiceId, IContextMenuService, IContextViewService, LocalizationServiceId, GitServiceId],
		}),
	}));
	const editorPanes = new EditorPaneRegistry();
	disposables.add(editorPanes.register({
		id: PreferencesEditorId,
		name: 'Preferences',
		canOpen: input => isPreferencesEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => new PreferencesEditor(instantiationService, localizationService, preferencesPanes),
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
		['general', 'appearance', 'editor'],
	);
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
	underline.click();
	await nextTurn();
	assert.equal(configuration.getValue(AccessibilityConfiguration.underlineLinks), true);
	const underlineIndicator = root.querySelector<HTMLElement>(`[data-settings-item-id="${AccessibilityConfiguration.underlineLinks}"] .ash-settings-indicators`);
	assert.equal(underlineIndicator?.textContent, 'Modified');
	assert.equal(underlineIndicator?.getAttribute('aria-label'), 'Setting has been modified');

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
	const modifiedFilter = menuActions.find(action => action.id === 'settings.search.modified');
	assert.ok(modifiedFilter);
	await modifiedFilter.run();
	hideMenu?.(false);
	assert.equal(search.value, '@modified');
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
