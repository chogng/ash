import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Direction } from '../../../../../base/browser/ui/grid/grid.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenuItemAction, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { Menus } from '../../../../browser/menus.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../../common/sessionCommands.js';
import type { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import type { DesktopLayoutController, IDesktopLayoutContext } from '../../../layout/browser/desktopLayoutController.js';
import { EditorTitleMenuBridgeContribution } from '../../browser/editor.contribution.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('editor contributions follow layout state, serialize open commands without Add tab UI and release window registrations', async () => {
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	contextKeys.setContext('sessions.editorTool', 'files');
	using commands = new CommandService(services);
	using layoutChanged = new Emitter<void>();
	using editorChanged = new Emitter<void>();
	const documentContent = observableValue('document content', true);
	const parts = { editor: false, auxiliarybar: true };
	const filesDetails = { isEditorVisible: false };
	const effects: string[] = [];
	const pending = new DeferredPromise<void>();
	const started = new DeferredPromise<void>();
	let queue = Promise.resolve();
	let supportsDetails = true;
	let changesVisible = false;
	const context: IDesktopLayoutContext = {
		isSessionContent: true,
		get isDocumentContent() { return documentContent.get(); },
		documentContent,
		isChangingContent: false,
		runOperation(operation) {
			queue = queue.then(operation);
			return queue;
		},
	};
	const controller = {
		get supportsDetails() { return supportsDetails; },
		async openFiles() {
			await started.complete();
			await pending.p;
			effects.push('files');
		},
		async openChanges() { effects.push('changes'); },
		async toggleChanges() { parts.editor = true; changesVisible = !changesVisible; },
		async hideEditor() { filesDetails.isEditorVisible = false; parts.auxiliarybar = true; },
		async showEditor() { parts.editor = true; filesDetails.isEditorVisible = true; },
		async toggleDetails() { parts.auxiliarybar = !parts.auxiliarybar; },
		async toggleSidePane() { parts.editor = false; parts.auxiliarybar = false; },
	} as unknown as DesktopLayoutController;
	services.registerInstance(ILayoutService, {
		isPartVisible: (part: keyof typeof parts) => parts[part],
		onDidLayoutMainContainer: layoutChanged.event,
	} as unknown as IAgentWorkbenchLayoutService);
	services.registerInstance(IEditorPart, {
		onDidChangeEditors: editorChanged.event, filesPart: filesDetails,
		groups: [{ id: 2, activeInput: { resource: URI.parse('ash-session-changes:/test') } }],
		isGroupVisible() { return changesVisible; },
		get filesDetailsOpen() { return parts.auxiliarybar; },
		get filesDetailsVisible() { return parts.editor && parts.auxiliarybar; },
		get fileEditorsVisible() { return true; },
	} as unknown as IEditorPart);
	services.registerInstance(IContextKeyService, contextKeys);
	const menus = new MenuService(commands, contextKeys);
	using title = menus.createMenu(MenuId.EditorTitle);
	using addTab = menus.createMenu(Menus.CodeAddTab);
	using palette = menus.createMenu(MenuId.CommandPalette);
	const paletteIds = () => palette.getActions().flatMap(([, actions]) => actions).map(action => action.id).sort();
	// Shared editor imports may already contribute commands to the same registry.
	const existingPaletteIds = paletteIds();
	using contribution = services.createInstance(EditorTitleMenuBridgeContribution, controller, context);
	using desktopTitle = menus.createMenu(Menus.SessionsEditorTitle);
	using headerLayout = menus.createMenu(Menus.SessionsEditorHeaderLayout);
	using layoutMenu = menus.createMenu(Menus.TitleBarRightLayout);
	const changesAction = () => layoutMenu.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.toggleChanges')!;
	const headerActions = () => headerLayout.getActions().flatMap(([, actions]) => actions);
	assert.deepEqual(headerActions().map(action => action.id), ['ash.sessions.toggleDetails', 'ash.sessions.maximizeTool', 'ash.sessions.hideTool']);
	const desktopIds = () => desktopTitle.getActions().flatMap(([, actions]) => actions).map(action => action.id);
	assert.deepEqual(desktopIds(), title.getActions().flatMap(([, actions]) => actions).map(action => action.id));
	const dynamic = MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
		command: { id: 'test.desktopEditor.action', title: 'Dynamic editor command' }, group: 'navigation',
	});
	assert.ok(desktopIds().includes('test.desktopEditor.action'));
	dynamic.dispose();
	assert.ok(!desktopIds().includes('test.desktopEditor.action'));
	const titleState = () => title.getActions().flatMap(([, actions]) => actions).map(action => [action.label, action.enabled, action.checked]);
	assert.deepEqual(titleState(), [['Toggle details', true, false], ['Show editor', true, undefined]]);
	assert.deepEqual(addTab.getActions(), []);
	assert.deepEqual(paletteIds(), [
		...existingPaletteIds,
		NEW_FILE_TAB_COMMAND_ID,
		'workbench.agentSessions.action.viewChanges',
		'ash.sessions.toggleSidePane',
		'ash.sessions.toggleDetails',
		'ash.sessions.showEditor',
	].sort());

	await commands.executeCommand('ash.sessions.showEditor');
	assert.deepEqual(titleState(), [['Toggle details', true, true], ['Hide editor', true, undefined]]);
	contextKeys.setContext('sessions.editorTool', 'terminal');
	assert.ok(!desktopIds().includes('ash.sessions.toggleDetails'));
	assert.ok(!desktopIds().includes('ash.sessions.hideEditor'));
	contextKeys.setContext('sessions.editorTool', 'files');
	await commands.executeCommand('ash.sessions.toggleDetails');
	assert.equal(contextKeys.getValue('sessions.detailsVisible'), false);
	assert.equal(contextKeys.getValue('sessions.filesVisible'), true, 'Files remains selected while its editor is visible without the attached tree');
	supportsDetails = false;
	editorChanged.fire();
	assert.equal(title.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.toggleDetails')?.enabled, false);
	parts.editor = false;
	layoutChanged.fire();
	assert.equal(contextKeys.getValue('sessions.editorContentVisible'), false);

	const files = commands.executeCommand(NEW_FILE_TAB_COMMAND_ID);
	await started.p;
	const changes = commands.executeCommand('workbench.agentSessions.action.viewChanges');
	assert.deepEqual(effects, []);
	await pending.complete();
	await Promise.all([files, changes]);
	assert.deepEqual(effects, ['files', 'changes']);
	assert.equal(changesAction().checked, false);
	await changesAction().run();
	assert.equal(changesVisible, true);
	assert.equal(changesAction().checked, true);
	await changesAction().run();
	assert.equal(changesVisible, false);
	assert.equal(changesAction().checked, false);
	changesVisible = true;
	editorChanged.fire();
	assert.equal(changesAction().checked, true, 'Opening Changes elsewhere updates the titlebar selection');
	parts.editor = false;
	layoutChanged.fire();
	assert.equal(changesAction().checked, false, 'Hiding the editor area clears the titlebar selection');
	parts.editor = true;
	layoutChanged.fire();
	assert.equal(changesAction().checked, true);
	changesVisible = false;
	editorChanged.fire();
	assert.equal(changesAction().checked, false, 'Closing Changes elsewhere clears the titlebar selection');
	parts.editor = false;
	layoutChanged.fire();
	documentContent.set(false, undefined);
	assert.deepEqual(headerActions(), []);
	assert.deepEqual(title.getActions(), []);
	assert.deepEqual(paletteIds(), existingPaletteIds);
	await commands.executeCommand('workbench.agentSessions.action.viewChanges');
	assert.deepEqual(effects, ['files', 'changes']);

	contribution.dispose();
	assert.deepEqual(addTab.getActions(), []);
	assert.deepEqual(paletteIds(), existingPaletteIds);
	assert.equal(CommandsRegistry.getCommand('workbench.agentSessions.action.viewChanges'), undefined);
	assert.equal(CommandsRegistry.getCommand(NEW_FILE_TAB_COMMAND_ID), undefined);
	assert.equal(CommandsRegistry.getCommand('ash.sessions.openFilesTab'), undefined);
	assert.equal(CommandsRegistry.getCommand('sessions.cards.files.expand'), undefined);
	assert.equal(CommandsRegistry.getCommand('sessions.cards.files.close'), undefined);
	for (const id of ['toggleDetails', 'hideEditor', 'showEditor', 'toggleSidePane', 'toggleChanges']) {
		assert.equal(CommandsRegistry.getCommand('ash.sessions.' + id), undefined);
	}
	assert.equal(layoutChanged.hasListeners(), false);
	assert.equal(editorChanged.hasListeners(), false);
	assert.equal(contextKeys.getValue('sessions.detailsVisible'), false);
	assert.equal(contextKeys.getValue('sessions.filesVisible'), false);
	assert.equal(contextKeys.getValue('sessions.changesVisible'), false);
	assert.equal(contextKeys.getValue('sessions.supportedDetails'), false);

	const catalog = productLanguagePackCatalogs.find(pack => pack.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, original) => catalog.bundles[bundle]?.[key] ?? original);
		documentContent.set(true, undefined);
		using translated = services.createInstance(EditorTitleMenuBridgeContribution, controller, context);
		assert.deepEqual(titleState().map(([label]) => label), ['切换详情', '显示编辑器']);
		assert.deepEqual(headerActions().map(action => action.label), ['切换详情', '切换工具区域大小', '隐藏工具区域']);
		assert.deepEqual(addTab.getActions(), []);
		assert.equal(palette.getActions().flatMap(([, actions]) => actions).find(action => action.id === NEW_FILE_TAB_COMMAND_ID)?.label, '打开文件标签');
		assert.equal(changesAction().label, '更改');
	} finally {
		resetNlsResolver();
	}
});

test('the Terminal title split opens a fresh shell below the selected group and cleans up on launch failure', async () => {
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using commands = new CommandService(services);
	contextKeys.setContext('sessions.editorTool', 'terminal');
	contextKeys.setContext('appServerAvailable', true);
	services.registerInstance(IContextKeyService, contextKeys);
	const unavailable = new TerminalEditorInput(URI.parse('vscode-terminal:/test/1'));
	const source = { id: 1, activeInput: unavailable, inputs: [unavailable], selectedInputs: [unavailable] };
	const destination = { id: 2, inputs: [] as TerminalEditorInput[] };
	const groups: { id: number; inputs: TerminalEditorInput[]; }[] = [source];
	let failLaunch = false;
	services.registerInstance(IEditorGroupsService, { getGroup: (id: number) => groups.find(group => group.id === id) } as IEditorGroupsService);
	services.registerInstance(ILayoutService, { isPartVisible: () => false, onDidLayoutMainContainer: Event.None } as unknown as IAgentWorkbenchLayoutService);
	services.registerInstance(IEditorPart, {
		groups,
		onDidChangeEditors: Event.None,
		addGroup(id: number, direction: Direction) {
			assert.equal(id, source.id);
			assert.equal(direction, Direction.Down);
			groups.push(destination);
			return destination;
		},
		async removeGroup(group: typeof destination) {
			assert.equal(group, destination);
			groups.splice(groups.indexOf(group), 1);
			return true;
		},
	} as unknown as IEditorPart);
	const fresh = new TerminalEditorInput(URI.parse('vscode-terminal:/test/2'));
	services.registerInstance(ITerminalService, {
		async createTerminal(options: unknown) {
			assert.deepEqual(options, { location: { viewColumn: destination.id, preserveFocus: false } });
			if (failLaunch) throw new Error('launch failed');
			destination.inputs.push(fresh);
			return { resource: fresh.resource };
		},
	} as ITerminalService);
	using splitMenu = MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
		command: { id: 'workbench.action.splitEditor', title: 'Split Down' },
		alt: { id: 'workbench.action.splitEditorRight', title: 'Split Right' },
	});
	using contribution = services.createInstance(EditorTitleMenuBridgeContribution, { supportsDetails: true }, {
		isDocumentContent: true,
		documentContent: observableValue('document content', true),
	});
	const menus = new MenuService(commands, contextKeys);
	using title = menus.createMenu(Menus.SessionsEditorTitle);
	const split = title.getActions({ arg: { groupId: source.id } }).flatMap(([, actions]) => actions)
		.find(action => action instanceof MenuItemAction && action.id === 'ash.sessions.splitTerminalDown');
	assert.ok(split instanceof MenuItemAction);
	assert.equal(split.label, 'Split Down');
	failLaunch = true;
	await assert.rejects(split.run(), /launch failed/);
	assert.deepEqual(groups, [source]);
	failLaunch = false;
	await split.run();
	assert.deepEqual(source.inputs, [unavailable]);
	assert.deepEqual(destination.inputs, [fresh]);
});
