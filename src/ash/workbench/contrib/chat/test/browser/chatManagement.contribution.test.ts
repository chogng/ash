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
		matches: (entry: ModelCatalogEntry) => !hostFilter || entry.displayName.includes(hostFilter),
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
	assert.equal(widget.itemCount, 3);
});

test('The model card contains the full model list without connection controls', async () => {
	using resources = new DisposableStore();
	const { services, root, models, menus, enabled } = setup(resources);
	models.listModelProviders = async () => ['openai', 'anthropic'].map(connection => ({ connection, provider: 'same', displayName: 'Same provider', access: 'apiKey', active: true, configured: false, ready: false, apiKeyPolicy: 'optional', apiKeyConfigured: false }));
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element);
	widget.render();
	await nextTurn();
	assert.equal(root.querySelector('.ash-chat-models-provider'), null);
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 3);
	assert.equal(root.querySelector('.ash-chat-models-filters, .ash-models-settings-expand'), null);
	assert.equal(root.querySelector('.ash-chat-models-provider input'), null);
	assert.equal(root.querySelector('.ash-chat-models-catalog > button'), null);
	widget.search('older');
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 1);
	assert.equal(widget.itemCount, 1);
	const toggle = root.querySelector<HTMLInputElement>('input[role="switch"]')!;
	toggle.click();
	await nextTurn();
	assert.deepEqual([...enabled], ['newest', 'older']);
	widget.clearSearch();
	assert.equal(root.querySelectorAll('.ash-models-settings-model-row').length, 3);
	assert.equal(widget.itemCount, 3);
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
		const { services, root, menus } = setup(resources);
		const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
		root.append(widget.element);
		widget.render();
		await nextTurn();
		const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]')!;
		assert.ok(search);
		widget.search('older');
		const implementation = AccessibleViewRegistry.getImplementations().find(candidate => candidate.name.startsWith('chat-models-') && candidate.type === AccessibleViewType.View);
		const provider = services.invokeFunction(implementation!.getProvider.bind(implementation!))!;
		assert.equal(provider.id, AccessibleViewProviderId.ChatModelConfiguration);
		assert.match(provider.provideContent(), /Older OpenAI/);
		assert.doesNotMatch(provider.provideContent(), /正在刷新模型/);
		provider.dispose();
		assert.equal(document.activeElement, search);
		assert.equal(root.querySelector('button[aria-label="Older OpenAI 的操作"]'), null);
		widget.focusSearch();
		const help = AccessibleViewRegistry.getImplementations().find(candidate => candidate.name.startsWith('chat-models-') && candidate.type === AccessibleViewType.Help)!;
		const helpProvider = services.invokeFunction(help.getProvider.bind(help))!;
		assert.match(helpProvider.provideContent(), /模型开关控制单个模型是否显示/);
		assert.match(helpProvider.provideContent(), /支持上下文切换的模型会在名称旁显示容量文字按钮/);
		assert.match(helpProvider.provideContent(), /独立的订阅账号卡片管理账号登录/);
		assert.doesNotMatch(helpProvider.provideContent(), /勾选|选择全部结果|所选模型|折叠|供应商开关|查看所有模型|搜索筛选条件/);
		helpProvider.dispose();
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


test('Catalog model switches save independently without selection controls', async () => {
	using resources = new DisposableStore();
	const { services, root, enabled, writes } = setup(resources);
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element);
	widget.render();
	await nextTurn();
	assert.equal(root.querySelector('input[type="checkbox"]:not([role="switch"])'), null);
	assert.equal(root.querySelector('.ash-chat-models-selection-actions'), null);
	const opus = root.querySelector<HTMLInputElement>('input[aria-label="Show Opus in model picker"]')!;
	opus.focus();
	opus.click();
	await nextTurn();
	assert.deepEqual([...enabled], ['newest', 'opus']);
	assert.equal(document.activeElement, opus);
	widget.search('older');
	const older = root.querySelector<HTMLInputElement>('input[aria-label="Show Older OpenAI in model picker"]')!;
	older.focus();
	older.click();
	await nextTurn();
	assert.deepEqual([...enabled], ['newest', 'opus', 'older']);
	writes.fail = true;
	older.click();
	await nextTurn();
	assert.deepEqual([...enabled], ['newest', 'opus', 'older']);
	assert.equal(root.querySelector('.ash-models-settings-status[role="alert"]')?.textContent, 'Could not save model visibility.');
	assert.equal(older.checked, true);
	assert.equal(older.disabled, false);
	assert.equal(document.activeElement, older);
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
	widget.search('@provider:op');
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
	input.dispatchEvent(new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
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

test('Ordinary models use switches without row menus and search filters preserve the query', async () => {
	using resources = new DisposableStore();
	const { services, root, menus, enabled: visibleModels } = setup(resources);
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, { onConfigure: async () => { throw new Error('Ordinary model rows must not configure providers'); } }));
	root.append(widget.element); widget.render(); await nextTurn();
	assert.equal(root.querySelector('.ash-models-settings-model-row button'), null);
	const toggle = root.querySelector<HTMLInputElement>('input[aria-label="Show Older OpenAI in model picker"]')!;
	toggle.focus();
	const selectAll = new browserEnvironment.window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
	toggle.dispatchEvent(selectAll);
	assert.equal(selectAll.defaultPrevented, false);
	for (const event of [
		new browserEnvironment.window.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }),
		new browserEnvironment.window.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }),
		new browserEnvironment.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
	]) {
		toggle.dispatchEvent(event);
		assert.equal(event.defaultPrevented, false);
	}
	assert.equal(menus.length, 0);
	toggle.click();
	await nextTurn();
	assert.deepEqual([...visibleModels], ['newest', 'older']);
	const newest = root.querySelector<HTMLInputElement>('input[aria-label="Show Newest OpenAI in model picker"]')!;
	newest.click();
	await nextTurn();
	assert.deepEqual([...visibleModels], ['older']);
	widget.search('@provider:openai Newest');
	const enabled = root.querySelector<HTMLInputElement>('input[aria-label="Show Newest OpenAI in model picker"]')!.checked;
	widget.search('@provider:openai Newest @capability:vision');
	const search = root.querySelector<HTMLInputElement>('[role="combobox"]')!;
	assert.equal(search.value, '@provider:openai Newest @capability:vision');
	assert.equal(document.activeElement, search);
	assert.equal(root.querySelector<HTMLInputElement>('input[aria-label="Show Newest OpenAI in model picker"]')!.checked, enabled);
});

test('Context buttons save model-specific usable capacities across providers', async () => {
	using resources = new DisposableStore();
	let sol: ModelCatalogEntry = {
		model: { provider: 'openai', model: 'gpt-6.1-sol' }, displayName: 'GPT-6.1 Sol',
		longContext: false, defaultContextWindow: 500000, maximumContextWindow: 872000, usableContextWindow: 475000,
	};
	let other: ModelCatalogEntry = { ...catalog[0], model: { provider: 'other-provider', model: 'switchable' }, displayName: 'Other model', longContext: false, defaultContextWindow: 128000, maximumContextWindow: 256000, usableContextWindow: 123456 };
	const { services, root, models, changes, notifications } = setup(resources, async () => [sol, other]);
	const pending = new DeferredPromise<void>();
	let fail = false;
	const writes: unknown[] = [];
	models.setModelPreferences = async (model, update) => {
		writes.push({ model, update });
		await pending.p;
		if (fail) { throw new Error('Fixture save failed'); }
		if (model.provider === sol.model.provider) {
			sol = { ...sol, longContext: update.longContext!, usableContextWindow: update.longContext ? 828400 : 475000 };
		} else {
			other = { ...other, longContext: update.longContext!, usableContextWindow: update.longContext ? 246912 : 123456 };
		}
		changes.fire();
	};
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element); widget.render(); await nextTurn();
	const button = root.querySelector<HTMLButtonElement>('button[aria-label="Context size for GPT-6.1 Sol"]')!;
	assert.ok(button);
	assert.equal(button.closest('label'), null);
	assert.equal(button.getAttribute('aria-pressed'), 'false');
	assert.equal(button.querySelector('.ash-model-context-default')!.textContent, '475K');
	assert.match(button.getAttribute('aria-description')!, /475,000/);
	const otherButton = root.querySelector<HTMLButtonElement>('button[aria-label="Context size for Other model"]')!;
	assert.equal(otherButton.querySelector('.ash-model-context-default')!.textContent, '123.5K');
	assert.equal(otherButton.closest('label'), null);
	assert.equal(root.querySelectorAll('.ash-select-box').length, 0);
	const otherRow = otherButton.closest('.ash-models-settings-model-row')!;
	const unrelatedMutations: MutationRecord[] = [];
	const observer = new browserEnvironment.window.MutationObserver(records => unrelatedMutations.push(...records));
	observer.observe(otherRow, { subtree: true, attributes: true, childList: true, characterData: true });
	resources.add(toDisposable(() => observer.disconnect()));
	let countChanges = 0;
	resources.add(widget.onDidChangeItemCount(() => countChanges++));
	const nameText = button.closest('.ash-models-settings-model-row')!.querySelector('.ash-icon-label-text')!.firstChild;
	button.focus(); button.click();
	assert.equal(button.disabled, false);
	assert.equal(button.getAttribute('aria-busy'), 'true');
	assert.equal(otherButton.disabled, false);
	assert.ok([...root.querySelectorAll<HTMLInputElement>('input[role="switch"]')].every(toggle => !toggle.disabled));
	button.click();
	assert.equal(writes.length, 1, 'Repeated activation of the saving control is coalesced');
	assert.equal(button.getAttribute('aria-pressed'), 'false', 'Saving does not invent an optimistic capacity');
	await pending.complete(); await nextTurn();
	assert.equal(button.getAttribute('aria-pressed'), 'true');
	assert.equal(button.querySelector('.ash-model-context-extended')!.textContent, '828.4K');
	assert.equal(document.activeElement, button);
	assert.equal(button.hasAttribute('aria-busy'), false);
	assert.equal(countChanges, 0, 'A capacity change does not invalidate the Settings tree');
	assert.deepEqual(unrelatedMutations, [], 'Unchanged rows receive no DOM updates');
	assert.equal(button.closest('.ash-models-settings-model-row')!.querySelector('.ash-icon-label-text')!.firstChild, nameText);
	observer.disconnect();
	assert.deepEqual(writes, [{ model: sol.model, update: { longContext: true } }]);
	fail = true;
	button.click(); await nextTurn();
	assert.equal(button.getAttribute('aria-pressed'), 'true');
	assert.equal(button.disabled, false);
	assert.equal(button.hasAttribute('aria-busy'), false);
	assert.equal(notifications.model.getNotifications().at(-1)?.message, 'Could not save model preferences.');
	fail = false;
	button.click(); await nextTurn();
	assert.equal(button.getAttribute('aria-pressed'), 'false');
	assert.equal(button.querySelector('.ash-model-context-default')!.textContent, '475K');
	otherButton.click(); await nextTurn();
	assert.equal(otherButton.getAttribute('aria-pressed'), 'true');
	assert.equal(otherButton.querySelector('.ash-model-context-extended')!.textContent, '246.9K');
	assert.deepEqual(writes.at(-1), { model: other.model, update: { longContext: true } });
	assert.equal(sol.longContext, false);
	button.focus();
	sol = { ...sol, usableContextWindow: null }; changes.fire(); await nextTurn();
	assert.equal(button.isConnected, false);
	assert.equal(document.activeElement, root.querySelector('input[aria-label="Show GPT-6.1 Sol in model picker"]'));
});

test('Context saves keep other models interactive and complete independently', async () => {
	using resources = new DisposableStore();
	let entries: readonly ModelCatalogEntry[] = ['first', 'second'].map(id => ({
		model: { provider: 'openai', model: id }, displayName: id, longContext: false, usableContextWindow: 128000,
	}));
	const { services, root, models, changes } = setup(resources, async () => entries);
	const pending = [new DeferredPromise<void>(), new DeferredPromise<void>()];
	const writes: string[] = [];
	models.setModelPreferences = async (model, update) => {
		writes.push(model.model);
		const index = entries.findIndex(entry => entry.model.model === model.model);
		await pending[index].p;
		entries = entries.map((entry, candidate) => candidate === index ? { ...entry, longContext: update.longContext!, usableContextWindow: 256000 } : entry);
		changes.fire();
	};
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element);
	widget.render();
	await nextTurn();
	const first = root.querySelector<HTMLButtonElement>('button[aria-label="Context size for first"]')!;
	const second = root.querySelector<HTMLButtonElement>('button[aria-label="Context size for second"]')!;
	first.click();
	second.click();
	first.click();
	second.click();
	assert.deepEqual(writes, ['first', 'second']);
	assert.ok([first, second].every(button => !button.disabled && button.getAttribute('aria-busy') === 'true'));
	assert.ok([...root.querySelectorAll<HTMLInputElement>('input[role="switch"]')].every(toggle => !toggle.disabled));
	await pending[0].complete();
	await nextTurn();
	assert.equal(first.getAttribute('aria-pressed'), 'true');
	assert.equal(first.hasAttribute('aria-busy'), false);
	assert.equal(second.getAttribute('aria-pressed'), 'false');
	assert.equal(second.getAttribute('aria-busy'), 'true');
	await pending[1].complete();
	await nextTurn();
	assert.equal(second.getAttribute('aria-pressed'), 'true');
	assert.equal(second.hasAttribute('aria-busy'), false);
});

test('Inline model settings save supported preferences and reveal the matching custom model', async () => {
	using resources = new DisposableStore();
	let entry: ModelCatalogEntry = {
		...catalog[0], model: { provider: 'custom-actual', model: 'newest' }, longContext: false, defaultContextWindow: 128000, maximumContextWindow: 1000000, usableContextWindow: 123456,
		accelerationOptions: [{ id: 'provider-fast', name: 'Fast', description: 'Provider choice' }], selectedAcceleration: 'provider-fast',
		source: { providerId: 'custom-actual', connectionId: 'custom-actual', metadata: 'providerSeed' },
	};
	const { services, root, models, changes } = setup(resources, async () => [entry]);
	models.setModelPreferences = async (_model, update) => { entry = { ...entry, ...update, usableContextWindow: update.longContext ? 987654 : 123456, selectedAcceleration: update.acceleration ?? entry.selectedAcceleration }; changes.fire(); };
	const configured: unknown[] = [];
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, { onConfigure: async (...args: unknown[]) => { configured.push(args); } }));
	root.append(widget.element); widget.render(); await nextTurn();

	const details = root.querySelector<HTMLElement>('.ash-model-details')!;
	assert.equal(details.hidden, false);
	const context = root.querySelector<HTMLButtonElement>('button[aria-label="Context size for Newest OpenAI"]')!;
	assert.equal(context.querySelector('.ash-model-context-default')!.textContent, '123.5K');
	context.click(); await nextTurn();
	assert.equal(context.querySelector('.ash-model-context-extended')!.textContent, '987.7K');
	assert.equal(entry.longContext, true);
	assert.equal(root.querySelector('button[aria-label="Speed for Newest OpenAI"]'), null);
	assert.equal(entry.selectedAcceleration, 'provider-fast');
	const edit = [...details.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Configure model')!;
	edit.click(); await nextTurn();
	assert.deepEqual(configured, [['custom-actual', 'newest']]);

});

test('Inline controls follow current model options without exposing connection actions', async () => {
	using resources = new DisposableStore();
	let entries: readonly ModelCatalogEntry[] = [
		{ ...catalog[0], longContext: false, defaultContextWindow: 128000, maximumContextWindow: 1000000, usableContextWindow: 123456 },
		{ ...catalog[1], accelerationOptions: [{ id: 'fast', name: 'Fast', description: 'Fixture speed' }] },
		{ ...catalog[2], model: { provider: 'custom-fixture', model: 'opus' } },
	];
	const { services, root, models, changes } = setup(resources, async () => entries);
	const configured: unknown[] = [];
	const refreshed: string[] = [];
	models.discoverProviderModels = async connection => { refreshed.push(connection); return []; };
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, { onConfigure: async (...args: unknown[]) => { configured.push(args); } }));
	root.append(widget.element); widget.render(); await nextTurn();

	assert.equal(root.querySelector('button[aria-label="Speed for Older OpenAI"]'), null);
	assert.equal(root.querySelectorAll('.ash-model-details:not([hidden])').length, 1);
	[...root.querySelectorAll<HTMLButtonElement>('.ash-model-details button')].find(button => button.textContent === 'Configure model')!.click(); await nextTurn();
	assert.deepEqual(configured, [['custom-fixture', 'opus']]);
	assert.equal(root.querySelector('.ash-chat-models-provider'), null);
	const previous = root.querySelector<HTMLButtonElement>('button[aria-label="Context size for Newest OpenAI"]')!;
	previous.focus();
	entries = [catalog[0], entries[1], entries[2]];
	changes.fire(); await nextTurn();
	assert.equal(previous.isConnected, false);
	assert.equal(root.querySelector('button[aria-label="Context size for Newest OpenAI"]'), null);
	assert.equal(document.activeElement, root.querySelector('input[aria-label="Show Newest OpenAI in model picker"]'));
	entries = [{ ...catalog[0], longContext: false, usableContextWindow: 123456 }, entries[1], entries[2]];
	changes.fire(); await nextTurn();
	assert.equal(root.querySelectorAll('button[aria-label="Context size for Newest OpenAI"]').length, 1);
});

test('An empty catalog keeps model loading feedback independent of connections', async () => {
	using resources = new DisposableStore();
	const { services, root } = setup(resources, async () => []);
	const widget = resources.add(services.createInstance(ChatModelsWidget, document, {}));
	root.append(widget.element); widget.render(); await nextTurn();
	assert.equal(widget.itemCount, 0);
	assert.equal(widget.hasResults, false);
	assert.match(root.textContent!, /No models available/);
	assert.equal(root.querySelector('.ash-chat-models-provider'), null);
});
