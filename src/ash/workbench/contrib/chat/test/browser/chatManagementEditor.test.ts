import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { AccessibleViewProviderId, AccessibleViewType, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { EditorPaneRegistry, EditorPanes } from '../../../../browser/editor.js';
import { EditorPart, IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { EditorInputCapabilities } from '../../../../common/editor.js';
import { EditorInputSerializers } from '../../../../services/editor/common/editorInputSerializer.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { BrowserEditorService } from '../../../../services/editor/browser/browserEditorService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { TestNotificationService } from '../../../../services/notification/test/common/testNotificationService.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { ModelsManagementEditor } from '../../browser/chatManagement/chatManagementEditor.js';
import { ModelsManagementEditorInput } from '../../browser/chatManagement/chatManagementEditorInput.js';
import { ChatModelsWidget } from '../../browser/chatManagement/chatModelsWidget.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../common/constants.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import '../../browser/chatManagement/chatManagement.contribution.js';

const document = browserEnvironment.window.document;
const catalog: readonly ModelCatalogEntry[] = [
	{ model: { provider: 'openai', model: 'newest' }, displayName: 'Newest OpenAI', longContext: null },
	{ model: { provider: 'openai', model: 'older' }, displayName: 'Older OpenAI', longContext: null },
	{ model: { provider: 'anthropic', model: 'opus' }, displayName: 'Opus', longContext: null },
];

function setup(resources: DisposableStore, read: () => Promise<readonly ModelCatalogEntry[]> = async () => catalog) {
	const services = resources.add(createTestEditorServices());
	const notifications = resources.add(new TestNotificationService());
	const changes = resources.add(new Emitter<void>());
	const enabled = new Set(['newest']);
	const writes = { fail: false };
	services.registerInstance(INotificationService, notifications);
	services.registerInstance(IAccessibleViewService, {
		...toDisposable(() => {}),
		show: () => false,
		getOpenAriaHint: () => undefined,
		disableHint: async () => {},
		showAccessibleViewHelp: () => {},
	});
	const models: Partial<ILanguageModelsService> = {
		onDidChangeModels: changes.event,
		listModelCatalog: read,
		listModelProviders: async () => [],
		isModelVisible: model => enabled.has(model.model),
		setModelVisible: async (model, value) => {
			if (writes.fail) {
				throw new Error('Write failed');
			}
			if (value) {
				enabled.add(model.model);
			} else {
				enabled.delete(model.model);
			}
			changes.fire();
		},
	};
	services.registerInstance(ILanguageModelsService, models as ILanguageModelsService);
	const settings: unknown[] = [];
	services.registerInstance(IPreferencesService, {
		openSettings: async options => {
			settings.push(options);
		},
	} as IPreferencesService);
	const root = document.createElement('main');
	document.body.append(root);
	resources.add(toDisposable(() => root.remove()));
	return { services, root, enabled, notifications, changes, settings, writes };
}

const nextTurn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('Models management command opens the registered editor, reuses it, filters and returns to provider settings', async () => {
	using resources = new DisposableStore();
	const { services, root, settings } = setup(resources);
	const registry = resources.add(new EditorPaneRegistry());
	resources.add(registry.registerEditorPane(EditorPanes.getEditorPanes().find(pane => pane.id === ModelsManagementEditor.ID)!));
	const part = resources.add(services.createInstance(EditorPart, root, { registry }));
	services.registerInstance(IEditorPart, part);
	services.registerInstance(IEditorService, resources.add(new BrowserEditorService(part)));
	const commands = resources.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	await assert.rejects(commands.executeCommand(MANAGE_CHAT_COMMAND_ID, 12), /Model search must be a string/);
	const opened = await commands.executeCommand(MANAGE_CHAT_COMMAND_ID, 'openai/older');
	await nextTurn();
	assert.ok(part.activePane instanceof ModelsManagementEditor);
	const pane = part.activePane;
	assert.equal(opened, pane);
	assert.deepEqual(
		[...root.querySelectorAll('.ash-models-settings-model-copy')].map(node => node.textContent),
		['Older OpenAI'],
	);
	await commands.executeCommand(MANAGE_CHAT_COMMAND_ID);
	assert.equal(part.activePane, pane);
	assert.equal(root.querySelectorAll('.ash-models-management-editor').length, 1);
	await services.get(IEditorService).openEditor(resources.add(new ModelsManagementEditorInput()), { pinned: true }, 'sideGroup');
	assert.equal(part.activePane, pane, 'A side-group request reveals the singleton pane');
	await commands.executeCommand('chat.models.action.clearSearchResults');
	const search = root.querySelector<HTMLInputElement>('input[type="search"]')!;
	assert.equal(search.value, '');
	assert.equal(document.activeElement, search);
	root.querySelector<HTMLButtonElement>('.ash-models-management-editor > button')!.click();
	assert.deepEqual(settings, [{ section: 'models' }]);
});

test('The shared catalog keeps local search independent of host search and restores switch focus after saving', async () => {
	using resources = new DisposableStore();
	const { services, root, enabled } = setup(resources);
	let hostFilter = '';
	const widget = resources.add(
		services.createInstance(ChatModelsWidget, document, {
			compact: true,
			matches: (entry: ModelCatalogEntry) => !hostFilter || entry.displayName.includes(hostFilter),
			isFiltering: () => !!hostFilter,
		}),
	);
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

test('Models management uses Chinese labels and accessibility content and restores search focus', async () => {
	initializeTestLocalization('zh-CN');
	try {
		using resources = new DisposableStore();
		const { services, root } = setup(resources);
		const pane = resources.add(services.createInstance(ModelsManagementEditor));
		pane.create(root);
		const input = resources.add(new ModelsManagementEditorInput());
		await pane.setInput(input, new AbortController().signal);
		await nextTurn();
		assert.equal(input.getName(), '语言模型');
		const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]')!;
		assert.ok(search);
		pane.search('older');
		pane.focus();
		const implementation = AccessibleViewRegistry.getImplementations().find(candidate => candidate.name.startsWith('chat-models-') && candidate.type === AccessibleViewType.View);
		const provider = services.invokeFunction(implementation!.getProvider.bind(implementation!))!;
		assert.equal(provider.id, AccessibleViewProviderId.ChatModelConfiguration);
		assert.equal(provider.provideContent(), 'openai\nOlder OpenAI, openai/older, 关闭');
		provider.dispose();
		assert.equal(document.activeElement, search);
	} finally {
		resetNlsResolver();
	}
});

test('Models management restoration preserves its input identity, icon and singleton capability', () => {
	using input = new ModelsManagementEditorInput();
	const snapshot = EditorInputSerializers.serialize(input);
	assert.equal(snapshot.typeId, ModelsManagementEditorInput.ID);
	const restored = EditorInputSerializers.deserialize(JSON.parse(JSON.stringify(snapshot)));
	assert.ok(restored instanceof ModelsManagementEditorInput);
	using restoredInput = restored;
	assert.equal(input.matches(restored), true);
	assert.equal(restored.getIcon().id, input.getIcon().id);
	assert.ok(restored.capabilities & EditorInputCapabilities.Singleton);
	assert.throws(() => EditorInputSerializers.deserialize({ typeId: snapshot.typeId, value: {} }), /Invalid serialized models management input/);
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
