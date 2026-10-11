import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { JSDOM } from 'jsdom';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { CommandsHistory } from '../../../../../platform/quickinput/browser/commandsQuickAccess.js';
import { ClearCommandHistoryAction } from '../../browser/commandsQuickAccess.js';
import '../../browser/quickAccess.contribution.js';
import { formatNlsMessage, localize2, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import { MenuId, MenusRegistry, IMenuService } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { CommandRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IDialogService, DialogResult, DialogSeverity } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import type { IQuickPick, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { DialogService } from '../../../../services/dialogs/common/dialogService.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { CommandsQuickAccessProvider } from '../../browser/commandsQuickAccess.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { CodeEditorService } from '../../../../services/editor/browser/codeEditorService.js';
import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';

function registerHistoryServices(services: InstantiationService, resources: DisposableStore): void {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	resources.add(toDisposable(() => dom.window.close()));
	services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
	services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'commands', flushInterval: 0 })));
}

test('Command Palette finds localized commands by their English title and reports command errors', async () => {
	using resources = new DisposableStore();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
	assert.ok(chinese);
	setNlsResolver((bundle, key, fallback, parameters) =>
		formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		const registry = new CommandRegistry();
		resources.add(registry.register('test.commandFailure', () => { throw new Error('Command failed'); }));
		resources.add(MenusRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: { id: 'test.commandFailure', title: localize2('debug.start', 'Start Debugging') },
		}));
		using services = new InstantiationService();
		registerHistoryServices(services, resources);
		services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
		services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
		const commands = resources.add(new CommandService(services, registry));
		const contexts = resources.add(new ContextKeyService());
		const dialogs = resources.add(new DialogService());
		services.registerInstance(ICommandService, commands);
		services.registerInstance(IMenuService, new MenuService(commands, contexts));
		services.registerInstance(IDialogService, dialogs);
		services.registerInstance(IKeybindingService, {
			lookupKeybinding: () => undefined,
			onDidUpdateKeybindings: Event.None,
		} as unknown as IKeybindingService);
		const provider = services.createInstance(CommandsQuickAccessProvider);
		const accept = resources.add(new Emitter<IQuickPickItem>());
		const picker = {
			value: '', filterValue: (value: string) => value, onDidChangeValue: Event.None, onDidTriggerItemButton: Event.None,
			items: [] as readonly IQuickPickItem[],
			onDidAccept: accept.event,
			hide() { },
		} as unknown as IQuickPick<IQuickPickItem>;
		resources.add(provider.provide(picker));
		const item = filterQuickPickItems(picker.items.filter((candidate): candidate is IQuickPickItem => !('type' in candidate)), 'Start Debugging').find(candidate => candidate.description === 'test.commandFailure');
		assert.ok(item && !('type' in item));
		assert.deepEqual([item.label, item.detail], ['启动调试', 'Start Debugging']);
		assert.ok(filterQuickPickItems(picker.items.filter((candidate): candidate is IQuickPickItem => !('type' in candidate)), '启动调试').includes(item));

		accept.fire(item);
		await Promise.resolve();
		const dialog = dialogs.model.dialogs[0];
		assert.deepEqual(dialog?.request, {
			kind: 'message',
			severity: DialogSeverity.Error,
			message: '命令“启动调试”执行时发生错误',
			detail: 'Command failed',
			title: '错误',
			primaryButton: '确定',
		});
		dialog.close({ button: DialogResult.Primary });
	} finally {
		resetNlsResolver();
	}
});

test('Command Palette does not show a dialog for cancelled commands', async () => {
	using resources = new DisposableStore();
	const registry = new CommandRegistry();
	resources.add(registry.register('test.cancelCommand', () => { throw new CancellationError(); }));
	resources.add(MenusRegistry.appendMenuItem(MenuId.CommandPalette, {
		command: { id: 'test.cancelCommand', title: 'Cancelled command' },
	}));
	using services = new InstantiationService();
	registerHistoryServices(services, resources);
	services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
	services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
	const commands = resources.add(new CommandService(services, registry));
	const contexts = resources.add(new ContextKeyService());
	const dialogs = resources.add(new DialogService());
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IMenuService, new MenuService(commands, contexts));
	services.registerInstance(IDialogService, dialogs);
	services.registerInstance(IKeybindingService, {
		lookupKeybinding: () => undefined,
		onDidUpdateKeybindings: Event.None,
	} as unknown as IKeybindingService);
	const provider = services.createInstance(CommandsQuickAccessProvider);
	const accept = resources.add(new Emitter<IQuickPickItem>());
	const picker = {
		value: '', filterValue: (value: string) => value, onDidChangeValue: Event.None, onDidTriggerItemButton: Event.None,
		items: [] as readonly IQuickPickItem[],
		onDidAccept: accept.event,
		hide() { },
	} as unknown as IQuickPick<IQuickPickItem>;
	resources.add(provider.provide(picker));
	const item = picker.items.find(candidate => candidate.label === 'Cancelled command');
	assert.ok(item && !('type' in item));

	accept.fire(item);
	await Promise.resolve();
	assert.deepEqual(dialogs.model.dialogs, []);
});

test('Command Palette retains the focused embedded editor actions while its picker owns focus', async () => {
	using resources = new DisposableStore();
	using services = new InstantiationService();
	registerHistoryServices(services, resources);
	services.registerInstance(IEditorPartsService, { activePane: undefined } as unknown as IEditorPartsService);
	services.registerSingleton(ICodeEditorService, () => services.createInstance(CodeEditorService));
	let focused = true;
	const editor = {
		getId: () => 'output', hasTextFocus: () => focused, hasWidgetFocus: () => false,
		getSupportedActions: () => [{ id: 'test.outputCommand', label: 'Output action', alias: 'Output action' }],
	} as unknown as ICodeEditor;
	const editors = services.get(ICodeEditorService);
	editors.addCodeEditor(editor);
	const executed: boolean[] = [];
	const registry = new CommandRegistry();
	resources.add(registry.register('test.outputCommand', () => { executed.push(focused); }));
	const commands = resources.add(new CommandService(services, registry));
	const contexts = resources.add(new ContextKeyService());
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IMenuService, new MenuService(commands, contexts));
	services.registerInstance(IDialogService, resources.add(new DialogService()));
	const updated = resources.add(new Emitter<void>());
	services.registerInstance(IKeybindingService, { lookupKeybinding: () => undefined, onDidUpdateKeybindings: updated.event } as unknown as IKeybindingService);
	const accept = resources.add(new Emitter<IQuickPickItem>());
	const picker = { items: [] as readonly IQuickPickItem[], value: '', filterValue: (value: string) => value, onDidChangeValue: Event.None, onDidTriggerItemButton: Event.None, onDidAccept: accept.event, hide: () => { focused = true; } } as unknown as IQuickPick<IQuickPickItem>;
	resources.add(services.createInstance(CommandsQuickAccessProvider).provide(picker));
	focused = false;
	updated.fire();
	const item = picker.items.find(candidate => !('type' in candidate) && candidate.description === 'test.outputCommand');
	assert.ok(item && !('type' in item));
	accept.fire(item);
	await Promise.resolve();
	assert.deepEqual(executed, [true]);
	editors.removeCodeEditor(editor);
	// Refresh after the captured preview editor has left its owning registry.
	editor.getSupportedActions = () => { throw new Error('Disposed preview editor'); };
	assert.doesNotThrow(() => updated.fire());
	assert.equal(picker.items.some(candidate => !('type' in candidate) && candidate.description === 'test.outputCommand'), false);
});

test('Command history restores profile recency, bounds entries and follows live settings and storage changes', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using configuration = new InMemoryConfigurationService();
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'first', flushInterval: 0 });
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IStorageService, storage);
		using history = services.createInstance(CommandsHistory);
		history.push('alpha');
		history.push('beta');
		history.push('alpha');
		assert.deepEqual([history.peek('beta'), history.peek('alpha'), history.peek('missing')], [1, 2, undefined]);
		await storage.flush();
		using restoredStorage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'second', flushInterval: 0 });
		using restoredServices = new InstantiationService();
		restoredServices.registerInstance(IConfigurationService, configuration);
		restoredServices.registerInstance(IStorageService, restoredStorage);
		using restored = restoredServices.createInstance(CommandsHistory);
		assert.deepEqual([restored.peek('beta'), restored.peek('alpha')], [1, 2], 'History follows the profile across workspaces and service recreation');
		await configuration.updateValue('workbench.commandPalette.history', 1);
		assert.deepEqual([history.peek('beta'), history.peek('alpha')], [undefined, 1]);
		history.push('gamma');
		assert.deepEqual([history.peek('alpha'), history.peek('gamma')], [undefined, 1]);
		history.remove('gamma');
		assert.equal(history.peek('gamma'), undefined);
		history.push('delta');
		CommandsHistory.clearHistory(configuration, storage);
		assert.equal(history.peek('delta'), undefined);
		await configuration.updateValue('workbench.commandPalette.history', 0);
		history.push('disabled');
		await configuration.updateValue('workbench.commandPalette.history', 50);
		assert.equal(history.peek('disabled'), undefined);
		for (const invalid of [-1, NaN, Infinity, '50']) {
			await assert.rejects(configuration.updateValue('workbench.commandPalette.history', invalid));
		}
		for (const raw of ['invalid json', '{"version":2,"entries":["alpha"]}', '{"version":1,"entries":["alpha",2]}', '{"version":1,"entries":["alpha","alpha"]}']) {
			storage.store('commandPalette.mru.cache', raw, StorageScope.PROFILE, StorageTarget.USER);
			assert.equal(history.peek('alpha'), undefined);
		}
		storage.store('commandPalette.mru.cache', '{"version":1,"entries":["external"]}', StorageScope.PROFILE, StorageTarget.USER);
		assert.equal(history.peek('external'), 1);
		using otherProfile = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'first', profileId: 'other', flushInterval: 0 });
		assert.equal(otherProfile.get('commandPalette.mru.cache', StorageScope.PROFILE), undefined);
	} finally {
		dom.window.close();
	}
});

test('Clear Command History keeps history on cancellation and clears it after confirmation', async () => {
	using resources = new DisposableStore();
	using services = new InstantiationService();
	registerHistoryServices(services, resources);
	const dialogs = resources.add(new DialogService());
	services.registerInstance(IDialogService, dialogs);
	const history = resources.add(services.createInstance(CommandsHistory));
	const action = new ClearCommandHistoryAction();
	for (const button of [DialogResult.Cancel, DialogResult.Primary]) {
		history.push('alpha');
		const pending = action.run(services);
		dialogs.model.dialogs[0].close({ button });
		await pending;
		assert.equal(history.peek('alpha'), button === DialogResult.Cancel ? 1 : undefined);
	}
});
