import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
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
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { CommandsQuickAccessProvider } from '../../browser/commandsQuickAccess.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { CodeEditorService } from '../../../../services/editor/browser/codeEditorService.js';
import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';

test('Command Palette finds localized commands by their English title and reports command errors', async () => {
	using resources = new DisposableStore();
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN');
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
			items: [] as readonly IQuickPickItem[],
			onDidAccept: accept.event,
			hide() {},
		} as unknown as IQuickPick<IQuickPickItem>;
		resources.add(provider.provide(picker));
		const item = filterQuickPickItems(picker.items, 'Start Debugging').find(candidate => candidate.description === 'test.commandFailure');
		assert.ok(item);
		assert.deepEqual([item.label, item.detail], ['启动调试', 'Start Debugging']);
		assert.ok(filterQuickPickItems(picker.items, '启动调试').includes(item));

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
		items: [] as readonly IQuickPickItem[],
		onDidAccept: accept.event,
		hide() {},
	} as unknown as IQuickPick<IQuickPickItem>;
	resources.add(provider.provide(picker));
	const item = picker.items.find(candidate => candidate.label === 'Cancelled command');
	assert.ok(item);

	accept.fire(item);
	await Promise.resolve();
	assert.deepEqual(dialogs.model.dialogs, []);
});

test('Command Palette retains the focused embedded editor actions while its picker owns focus', async () => {
	using resources = new DisposableStore();
	using services = new InstantiationService();
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
	const picker = { items: [] as readonly IQuickPickItem[], onDidAccept: accept.event, hide: () => { focused = true; } } as unknown as IQuickPick<IQuickPickItem>;
	resources.add(services.createInstance(CommandsQuickAccessProvider).provide(picker));
	focused = false;
	updated.fire();
	const item = picker.items.find(candidate => candidate.description === 'test.outputCommand');
	assert.ok(item);
	accept.fire(item);
	await Promise.resolve();
	assert.deepEqual(executed, [true]);
	editors.removeCodeEditor(editor);
});
