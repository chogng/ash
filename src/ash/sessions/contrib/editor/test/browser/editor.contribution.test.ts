import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
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
import { IsSessionsWindowContext, ResourceSchemeContext } from '../../../../../workbench/common/contextkeys.js';
import { IChatAttachmentResolveService } from '../../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { ITerminalEditorService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import type { ChatContextAttachment } from '../../../../../workbench/services/chat/common/chatContextService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { Menus } from '../../../../browser/menus.js';
import type { SessionsPart } from '../../../../browser/parts/sessionsPart.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../../common/sessionCommands.js';
import type { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import type { DesktopLayoutController, IDesktopLayoutContext } from '../../../layout/browser/desktopLayoutController.js';
import { EditorTitleMenuBridgeContribution, registerAddFileAsContextAction } from '../../browser/editor.contribution.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('the Command Palette adds the active file to the Sessions draft', async () => {
	using aria = setARIAContainer(browserEnvironment.window.document.body);
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using commands = new CommandService(services);
	const menus = new MenuService(commands, contextKeys);
	const file = { resource: URI.file('/fixture/main.ts') };
	const group = { id: 1, activeInput: file, inputs: [file], selectedInputs: [file], editors: [] };
	services.registerInstance(IEditorGroupsService, { activeGroup: group, groups: [group], getGroup: () => group } as unknown as IEditorGroupsService);
	const attachment: ChatContextAttachment = {
		id: 'main', kind: 'file', resource: file.resource, name: 'main.ts',
		resolve: async () => ({ name: 'main.ts', content: 'export {};\n' }),
	};
	services.registerInstance(IChatAttachmentResolveService, {
		resolveEditorAttachContext: async input => {
			assert.equal(input, file);
			return attachment;
		},
	} as IChatAttachmentResolveService);
	const draft: ChatContextAttachment[] = [];
	using action = registerAddFileAsContextAction({
		async acquireContext(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>) {
			const prepared = await prepare(new AbortController().signal);
			draft.push(...prepared);
			return prepared;
		},
	} as SessionsPart);
	const entry = () => menus.getMenuActions(MenuId.CommandPalette).flatMap(([, actions]) => actions)
		.find(action => action.id === 'workbench.action.agentSessions.addFileAsContext');
	ResourceSchemeContext.bindTo(contextKeys).set('file');
	assert.equal(entry(), undefined);
	IsSessionsWindowContext.bindTo(contextKeys).set(true);
	await entry()!.run();
	assert.deepEqual(draft, [attachment]);
	ResourceSchemeContext.bindTo(contextKeys).set('ash-session-changes');
	assert.equal(entry(), undefined);
});

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
		assert.equal(palette.getActions().flatMap(([, actions]) => actions).find(action => action.id === NEW_FILE_TAB_COMMAND_ID)?.label, '打开文件');
		assert.equal(changesAction().label, '更改');
		contextKeys.setContext('sessions.editorTool', 'terminal');
		assert.equal(desktopTitle.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.splitTerminalDown')?.label, '向下拆分');
		contextKeys.setContext('groupEditorsCount', 1);
		assert.equal(desktopTitle.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.closeTerminalPane')?.label, '关闭当前窗格');
	} finally {
		resetNlsResolver();
	}
});

test('the Terminal title split targets the current tab without creating an editor group', async () => {
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using commands = new CommandService(services);
	contextKeys.setContext('sessions.editorTool', 'terminal');
	contextKeys.setContext('appServerAvailable', true);
	services.registerInstance(IContextKeyService, contextKeys);
	const input = new TerminalEditorInput(URI.parse('vscode-terminal:/test/1'));
	const source = { id: 1, activeInput: input, inputs: [input], selectedInputs: [input] };
	services.registerInstance(IEditorGroupsService, { getGroup: () => source } as unknown as IEditorGroupsService);
	services.registerInstance(ILayoutService, { isPartVisible: () => false, onDidLayoutMainContainer: Event.None } as unknown as IAgentWorkbenchLayoutService);
	services.registerInstance(IEditorPart, { groups: [source], onDidChangeEditors: Event.None } as unknown as IEditorPart);
	let splitInput: TerminalEditorInput | undefined;
	services.registerInstance(ITerminalEditorService, {
		async splitPane(input: TerminalEditorInput, preserveFocus: boolean) {
			assert.equal(preserveFocus, false);
			splitInput = input;
		},
	} as ITerminalEditorService);
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
	await split.run();
	assert.equal(splitInput, input);
});
