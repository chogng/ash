import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { AccessibleViewProviderId, AccessibleViewType, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { EditorPaneRegistry, EditorPanes } from '../../../../browser/editor.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { ChatModelsWidget } from '../../browser/chatManagement/chatModelsWidget.js';
import { createManageModelsAction } from '../../browser/widget/input/modelPicker/modelPickerItems.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../common/constants.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import '../../browser/chatManagement/chatManagement.contribution.js';

const document = browserEnvironment.window.document;
const catalog: readonly ModelCatalogEntry[] = [
	{ model: { provider: 'openai', model: 'newest' }, displayName: 'Newest OpenAI', longContext: null, inputModalities: ['text', 'image'] },
	{ model: { provider: 'openai', model: 'older' }, displayName: 'Older OpenAI', longContext: null },
	{ model: { provider: 'anthropic', model: 'opus' }, displayName: 'Opus', longContext: null },
];

function setup(resources: DisposableStore, read: () => Promise<readonly ModelCatalogEntry[]> = async () => catalog) {
	const services = resources.add(createTestEditorServices());
	const notifications = resources.add(new TestNotificationService());
	const changes = resources.add(new Emitter<void>());
	const enabled = new Set(['newest']);
	const writes = { fail: false };
	const menus: IContextMenuDelegate[] = [];
	services.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom', onDidShowContextMenu: changes.event, onDidHideContextMenu: changes.event,
		showContextMenu: delegate => { assert.ok(delegate.getActions); menus.push({ ...delegate, getActions: delegate.getActions }); },
		hideContextMenu: () => { },
	});
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IAccessibleViewService, {
		...toDisposable(() => { }), show: () => false, getOpenAriaHint: () => undefined,
		disableHint: async () => { }, showAccessibleViewHelp: () => { },
	});
	const models: Partial<ILanguageModelsService> = {
		onDidChangeModels: changes.event, listModelCatalog: read, listModelProviders: async () => [],
		isModelVisible: model => enabled.has(model.model),
		setModelVisible: async (model, value) => {
			if (writes.fail) { throw new Error('Write failed'); }
			if (value) { enabled.add(model.model); } else { enabled.delete(model.model); }
			changes.fire();
		},
	};
	services.registerInstance(ILanguageModelsService, models as ILanguageModelsService);
	const settings: unknown[] = [];
	services.registerInstance(IPreferencesService, { openSettings: async options => { settings.push(options); } } as IPreferencesService);
	const root = document.createElement('main');
	document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	return { services, root, enabled, notifications, changes, settings, writes, models, menus };
}

const nextTurn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('Models management and Add Models open graphical Models settings and forward or clear the search', async () => {
	using resources = new DisposableStore();
	const { services, settings } = setup(resources);
	const commands = resources.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	await assert.rejects(commands.executeCommand(MANAGE_CHAT_COMMAND_ID, 12), /Model search must be a string/);
	assert.deepEqual(settings, []);
	await commands.executeCommand(MANAGE_CHAT_COMMAND_ID, 'openai/older');
	await commands.executeCommand(MANAGE_CHAT_COMMAND_ID);
	await createManageModelsAction(commands).run();
	assert.deepEqual(settings, [
		{ section: 'models', query: '', sectionQuery: 'openai/older', jsonEditor: false, focusSearch: true },
		{ section: 'models', query: '', sectionQuery: '', jsonEditor: false, focusSearch: true },
		{ section: 'models', query: '', sectionQuery: '', jsonEditor: false, focusSearch: true },
	]);
	assert.equal(EditorPanes.getEditorPanes().some(pane => pane.id === 'workbench.editor.modelsManagement'), false);
});

test('The shared catalog keeps local search independent of host search and restores switch focus after saving', async () => {
	using resources = new DisposableStore();
	const { services, root, enabled } = setup(resources);
	let hostFilter = '';
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {
		compact: true,
		matches: (entry: ModelCatalogEntry) => !hostFilter || entry.displayName.includes(hostFilter),
		isFiltering: () => !!hostFilter,
	}));
	root.append(widget.element);
	widget.render();
	await nextTurn();
	widget.search('openai');
	hostFilter = 'Older';
	widget.render();
	assert.equal(widget.itemCount, 1);
	hostFilter = '';
	widget.render();
	assert.equal(widget.itemCount, 2);
	const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
	assert.equal(search.value, 'openai');
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(search.value, '');
	const opus = root.querySelector<HTMLInputElement>('input[aria-label="Show Opus in model picker"]')!;
	opus.focus();
	const space = new browserEnvironment.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
	opus.dispatchEvent(space);
	assert.equal(space.defaultPrevented, false, 'Model hover must not consume the native switch activation key');
	assert.equal(document.activeElement, opus);
	opus.click();
	await nextTurn();
	assert.equal(enabled.has('opus'), true);
	assert.equal(opus.checked, true);
	assert.equal(document.activeElement, opus);
	assert.equal(widget.itemCount, 2);
});

test('Expanded Models settings exposes filters and connection-scoped group controls, then restores the overview', async () => {
	using resources = new DisposableStore();
	const { services, root, enabled, models, writes } = setup(resources);
	models.listModelProviders = async () => ['openai', 'anthropic'].map(connection => ({ connection, provider: 'same', displayName: 'Same provider', access: 'apiKey', active: true, configured: false, ready: false, apiKeyPolicy: 'optional', apiKeyConfigured: false }));
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, { compact: true }));
	root.append(widget.element);
	widget.render();
	await nextTurn();
	const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
	const expand = root.querySelector<HTMLButtonElement>('.ash-models-settings-expand button')!;
	const filters = root.querySelector<HTMLDetailsElement>('.ash-chat-models-filters')!;
	assert.equal(root.querySelector('.ash-chat-models-provider'), null);
	assert.equal(filters.hidden, true);
	expand.click();
	assert.equal(filters.hidden, false);
	assert.equal(root.querySelectorAll('.ash-chat-models-provider').length, 2);
	assert.equal(root.querySelector('button[aria-label^="Pin "], button[aria-label^="Unpin "]'), null);
	widget.search('older');
	const group = root.querySelector<HTMLElement>('.ash-chat-models-provider')!;
	const toggle = group.querySelector<HTMLInputElement>('input[role="switch"]')!;
	assert.equal(toggle.checked, true, 'The enabled model outside this search still determines group visibility');
	toggle.focus();
	toggle.click();
	await nextTurn();
	assert.equal(enabled.has('newest'), false);
	assert.equal(enabled.has('older'), false);
	assert.equal(enabled.has('opus'), false, 'An identically named connection remains untouched');
	assert.equal(document.activeElement, toggle);
	toggle.click();
	await nextTurn();
	assert.equal(enabled.has('newest'), true);
	assert.equal(enabled.has('older'), true);
	assert.equal(enabled.has('opus'), false);
	writes.fail = true;
	toggle.click();
	await nextTurn();
	assert.equal(toggle.checked, true);
	assert.equal(toggle.disabled, false);
	assert.equal(document.activeElement, toggle);
	assert.equal(root.querySelector('.ash-models-settings-status')?.textContent, 'Could not save model visibility.');
	widget.search('');
	filters.open = true;
	[...filters.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '@capability:vision')!.click();
	assert.equal(search.value, '@capability:vision');
	assert.equal(document.activeElement, search);
	assert.equal(filters.open, false);
	assert.deepEqual([...root.querySelectorAll('.ash-models-settings-model-copy > span')].map(row => row.textContent), ['Newest OpenAI']);
	search.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Collapse All')!.click();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 0);
	assert.equal(root.querySelectorAll('.ash-chat-models-provider').length, 2);
	assert.equal(widget.hasResults, true, 'Collapsed matching groups must remain in the outer Settings search');
	widget.render({ expandGroups: true });
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 3);
	[...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Collapse All')!.click();
	expand.click();
	assert.equal(root.querySelector('.ash-chat-models-provider'), null);
	assert.equal(filters.hidden, true);
	assert.deepEqual([...root.querySelectorAll('.ash-models-settings-model-copy > span')].map(row => row.textContent), ['Newest OpenAI', 'Opus']);
	expand.click();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 3);
});

test('A failed model visibility write restores the switch and reports the error inline', async () => {
	using resources = new DisposableStore();
	const { services, root, notifications, writes } = setup(resources);
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element);
	widget.render();
	await nextTurn();
	widget.search('older');
	writes.fail = true;
	const toggle = root.querySelector<HTMLInputElement>('input[aria-label="Show Older OpenAI in model picker"]')!;
	toggle.focus();
	toggle.click();
	await nextTurn();
	assert.equal(toggle.checked, false);
	assert.equal(toggle.disabled, false);
	assert.equal(document.activeElement, toggle);
	assert.equal(root.querySelector('.ash-models-settings-status[role="alert"]')?.textContent, 'Could not save model visibility.');
	assert.equal(notifications.model.getNotifications().at(-1)?.message, 'Could not save model visibility.');
});

test('Models settings catalog uses Chinese accessibility content and restores search focus', async () => {
	initializeTestLocalization('zh-CN');
	try {
		using resources = new DisposableStore();
		const { services, root } = setup(resources);
		const widget = resources.add(services.createInstance(ChatModelsWidget, document, { compact: true }));
		root.append(widget.element);
		widget.render();
		await nextTurn();
		const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]')!;
		assert.ok(search);
		widget.search('older');
		const implementation = AccessibleViewRegistry.getImplementations().find(candidate => candidate.name.startsWith('chat-models-') && candidate.type === AccessibleViewType.View);
		const provider = services.invokeFunction(implementation!.getProvider.bind(implementation!))!;
		assert.equal(provider.id, AccessibleViewProviderId.ChatModelConfiguration);
		assert.equal(provider.provideContent(), 'Older OpenAI');
		provider.dispose();
		assert.equal(document.activeElement, search);
	} finally { resetNlsResolver(); }
});

test('Working set restoration drops retired Language Models tabs', async () => {
	using resources = new DisposableStore();
	const { services, root } = setup(resources);
	const registry = resources.add(new EditorPaneRegistry());
	const part = resources.add(services.createInstance(EditorPart, root, { registry }));
	const workingSet = part.saveWorkingSet('legacy-models');
	await part.applyWorkingSet({
		...workingSet,
		groups: workingSet.groups.map((group, index) => index === 0 ? {
			...group,
			activeEditorIndex: 0,
			editors: [{ input: { typeId: 'workbench.input.modelsManagement', value: null }, paneId: 'workbench.editor.modelsManagement', preview: false }],
		} : group),
	});
	assert.equal(part.activeInput, undefined);
	assert.deepEqual(part.saveWorkingSet('current').groups.flatMap(group => group.editors), []);
});

test('A hidden or disposed catalog ignores pending results and no longer observes model changes', async () => {
	using resources = new DisposableStore();
	const pending = new DeferredPromise<readonly ModelCatalogEntry[]>();
	const { services, root, notifications, changes } = setup(resources, () => pending.p);
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element);
	widget.render();
	widget.element.hidden = true;
	await pending.complete(catalog);
	await nextTurn();
	assert.equal(widget.itemCount, 0);
	widget.element.hidden = false;
	widget.render();
	widget.dispose();
	changes.fire();
	await nextTurn();
	assert.equal(root.querySelector('.ash-chat-models-catalog'), null);
	assert.equal(notifications.model.getNotifications().length, 0);
});


test('Catalog selections support ranges, keyboard navigation and bulk visibility across providers', async () => {
	using resources = new DisposableStore();
	const { services, root, enabled, writes } = setup(resources);
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element);
	widget.render();
	await nextTurn();
	const select = (name: string) => root.querySelector<HTMLInputElement>(`input[aria-label="Select ${name}"]`)!;
	const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)!;
	select('Newest OpenAI').click();
	select('Opus').dispatchEvent(new browserEnvironment.window.MouseEvent('click', { shiftKey: true, bubbles: true }));
	assert.equal(root.querySelectorAll('input[type="checkbox"]:checked:not([role="switch"])').length, 3);
	select('Newest OpenAI').focus();
	select('Newest OpenAI').dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
	assert.equal(document.activeElement, select('Older OpenAI'));
	button('Hide selected').click();
	await nextTurn();
	assert.deepEqual([...enabled], []);
	button('Show selected').focus();
	button('Show selected').click();
	await nextTurn();
	assert.equal(document.activeElement, button('Show selected'));
	assert.deepEqual([...enabled], ['newest', 'older', 'opus']);
	button('Hide selected').click();
	await nextTurn();
	assert.deepEqual([...enabled], []);
	button('Clear selection').click();
	assert.equal(button('Show selected').disabled, true);
	widget.search('older');
	button('Select all results').click();
	button('Show selected').click();
	await nextTurn();
	assert.deepEqual([...enabled], ['older']);
	writes.fail = true;
	button('Hide selected').focus();
	button('Hide selected').click();
	await nextTurn();
	assert.deepEqual([...enabled], ['older']);
	assert.equal(root.querySelector('.ash-models-settings-status[role="alert"]')?.textContent, 'Could not save model preferences.');
	assert.equal(button('Hide selected').disabled, false);
	assert.equal(document.activeElement, button('Hide selected'));
});

test('Model filter completions expose an accessible active option and Escape dismisses before clearing', async () => {
	using resources = new DisposableStore();
	const { services, root } = setup(resources);
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element);
	widget.render();
	await nextTurn();
	widget.search('@cap');
	const input = root.querySelector<HTMLInputElement>('[role="combobox"]')!;
	assert.equal(input.getAttribute('aria-expanded'), 'true');
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
	assert.equal(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent, '@capability:vision');
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.equal(input.value, '@capability:vision');
	assert.equal(widget.itemCount, 1);
	widget.search('@pro');
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(input.value, '@pro');
	assert.equal(input.getAttribute('aria-expanded'), 'false');
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(input.value, '');
	widget.search('@pro');
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
	assert.equal(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent, '@provider:"anthropic"');
	widget.search('@provider:op');
	root.querySelector<HTMLElement>('[role="option"]')!.click();
	assert.equal(input.value, '@provider:"openai"');
	assert.equal(widget.itemCount, 2);
	assert.equal(document.activeElement, input);
});


test('Inserting an exact provider filter dismisses suggestions for connections sharing its prefix', async () => {
	using resources = new DisposableStore();
	const { services, root } = setup(resources, async () => [...catalog, { model: { provider: 'openai-compatible', model: 'other' }, displayName: 'Compatible', longContext: null }]);
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element);
	widget.render();
	await nextTurn();
	const input = root.querySelector<HTMLInputElement>('[role="combobox"]')!;
	[...root.querySelectorAll<HTMLButtonElement>('.ash-chat-models-filters button')].find(button => button.textContent === '@provider:openai')!.click();
	assert.equal(input.value, '@provider:"openai"');
	assert.equal(input.getAttribute('aria-expanded'), 'false');
	assert.equal(widget.itemCount, 2);
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert.equal(input.value, '');
});


test('Management rows omit capability labels and Accessible View retains translated metadata and prices', async () => {
	initializeTestLocalization('zh-CN');
	try {
		using resources = new DisposableStore();
		const { services, root } = setup(resources, async () => [
			{
				...catalog[0],
				capabilities: { toolCalling: 'supported', agentMode: 'unsupported' },
				source: { providerId: 'openai', connectionId: 'api', metadata: 'providerLive' },
				pricing: [{
					currency: 'USD', serviceTier: 'default', region: 'global', minInputTokens: 0, maxInputTokens: null,
					input: '0', output: '2.5', cacheRead: null, cacheWrite: null,
					revision: 'fixture', reviewedAt: '2026-09-04', sourceUrls: ['https://example.test/prices'],
				}],
			},
			catalog[1],
			{ ...catalog[2], capabilities: { toolCalling: 'unsupported', agentMode: 'unknown' } },
		]);
		const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
		root.append(widget.element);
		widget.render();
		await nextTurn();
		const rows = [...root.querySelectorAll<HTMLElement>('.ash-models-settings-model-row')];
		assert.equal(rows.length, 3);
		for (const row of rows) { assert.doesNotMatch(row.textContent ?? '', /工具调用|图像输入|Agent 模式/); }
		assert.equal(root.querySelector('.ash-models-settings-model-metadata'), null);
		widget.focusSearch();
		const implementation = AccessibleViewRegistry.getImplementations().find(candidate => candidate.name.startsWith('chat-models-') && candidate.type === AccessibleViewType.View)!;
		const provider = services.invokeFunction(implementation.getProvider.bind(implementation))!;
		const details = provider.provideContent();
		for (const fact of [
			'工具调用：支持；Agent 模式：不支持', '工具调用：未知；Agent 模式：未知', '图像输入',
			'供应商实时目录', '连接：api', '参考价格', '每百万 token，USD', '输入 0',
			'2026-09-04', 'fixture', 'https://example.test/prices',
		]) {
			assert.ok(details.includes(fact), fact);
		}
		provider.dispose();
	} finally { resetNlsResolver(); }
});

test('Keyboard ranges and context menus operate on the current selection and search filters preserve the query', async () => {
	using resources = new DisposableStore();
	const { services, root, menus, enabled: visibleModels } = setup(resources);
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element); widget.render(); await nextTurn();
	const select = root.querySelector<HTMLInputElement>('input[aria-label="Select Newest OpenAI"]')!;
	select.focus();
	select.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
	assert.equal(root.querySelectorAll('input[type="checkbox"]:checked:not([role="switch"])').length, 2);
	(document.activeElement as HTMLElement).dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
	assert.equal(root.querySelectorAll('input[type="checkbox"]:checked:not([role="switch"])').length, 3);
	select.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
	assert.deepEqual(menus.at(-1)!.getActions().map(action => action.id), ['visibility']);
	await menus.at(-1)!.getActions().find(action => action.id === 'visibility')!.run();
	assert.deepEqual([...visibleModels], []);
	widget.search('@provider:openai Newest');
	const filters = root.querySelector<HTMLDetailsElement>('.ash-chat-models-filters')!;
	filters.open = true;
	const vision = [...filters.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '@capability:vision')!;
	const enabled = root.querySelector<HTMLInputElement>('input[aria-label="Show Newest OpenAI in model picker"]')!.checked;
	vision.click();
	const search = root.querySelector<HTMLInputElement>('[role="combobox"]')!;
	assert.equal(search.value, '@provider:openai Newest @capability:vision');
	assert.equal(filters.open, false);
	assert.equal(document.activeElement, search);
	assert.equal(root.querySelector<HTMLInputElement>('input[aria-label="Show Newest OpenAI in model picker"]')!.checked, enabled);
});

test('Model menus save supported preferences and configuration shortcuts use the actual connection', async () => {
	using resources = new DisposableStore();
	let entry: ModelCatalogEntry = {
		...catalog[0], model: { provider: 'custom-actual', model: 'newest' }, longContext: false, defaultContextWindow: 128000, maximumContextWindow: 1000000,
		accelerationOptions: [{ id: 'provider-fast', name: 'Fast', description: 'Provider choice' }], selectedAcceleration: null,
		source: { providerId: 'custom-actual', connectionId: 'custom-actual', metadata: 'providerSeed' },
	};
	const { services, root, models, menus, changes } = setup(resources, async () => [entry]);
	models.setModelPreferences = async (_model, update) => { entry = { ...entry, ...update, selectedAcceleration: update.acceleration ?? entry.selectedAcceleration }; changes.fire(); };
	const configured: unknown[] = [];
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, { onConfigure: async (...args: unknown[]) => { configured.push(args); } }));
	root.append(widget.element); widget.render(); await nextTurn();
	const openMenu = (): readonly import('../../../../../base/common/actions.js').IAction[] => {
		root.querySelector<HTMLButtonElement>('button[aria-label="Actions for Newest OpenAI"]')!.click();
		return menus.at(-1)!.getActions();
	};
	const context = openMenu().find(action => action.id === 'context') as import('../../../../../base/common/actions.js').SubmenuAction;
	await context.actions.find(action => action.id === 'context.true')!.run(); await nextTurn();
	assert.equal(entry.longContext, true);
	const acceleration = openMenu().find(action => action.id === 'acceleration') as import('../../../../../base/common/actions.js').SubmenuAction;
	await acceleration.actions.find(action => action.id === 'acceleration.provider-fast')!.run(); await nextTurn();
	assert.equal(entry.selectedAcceleration, 'provider-fast');
	await openMenu().find(action => action.id === 'configureModel')!.run();
	assert.deepEqual(configured, [['custom-actual', 'newest']]);
});

test('An empty provider keeps its header when collapsed and its status respects host filtering', async () => {
	using resources = new DisposableStore();
	const { services, root, models } = setup(resources, async () => []);
	models.listModelProviders = async () => [{
		connection: 'empty', provider: 'empty', displayName: 'Empty', access: 'apiKey', active: true,
		configured: true, ready: true, apiKeyPolicy: 'optional', apiKeyConfigured: true,
		catalog: { provider: 'empty', connection: 'empty', freshness: 'fresh', issues: [] },
	}];
	let matches = true;
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, { compact: true, matchesProvider: () => matches }));
	root.append(widget.element); widget.render(); await nextTurn();
	const header = root.querySelector('.ash-chat-models-provider')!;
	assert.match(root.textContent!, /This connection returned no models/);
	header.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
	assert.equal(root.querySelector('.ash-chat-models-provider'), header);
	header.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click();
	assert.match(root.querySelector('.ash-models-catalog-connection-status')!.textContent!, /no models/);
	matches = false; widget.render();
	assert.equal(root.querySelector('.ash-chat-models-provider'), null);
});
