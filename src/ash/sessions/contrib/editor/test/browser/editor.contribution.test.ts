import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenusRegistry, SubmenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { CODE_EDITOR_ID } from '../../../../../workbench/browser/parts/editor/textResourceEditor.js';
import { IsSessionsWindowContext, ResourceSchemeContext } from '../../../../../workbench/common/contextkeys.js';
import { IChatAttachmentResolveService } from '../../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { ITerminalEditorService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { Direction } from '../../../../../base/browser/ui/grid/grid.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import type { ChatContextAttachment } from '../../../../../workbench/services/chat/common/chatContextService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { Menus, SessionsFlatLayoutContext } from '../../../../browser/menus.js';
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
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const flatLayout = SessionsFlatLayoutContext.bindTo(contextKeys);
	flatLayout.set(true);
	contextKeys.setContext('sessions.editorTool', 'files');
	using commands = new CommandService(services);
	using layoutChanged = new Emitter<void>();
	using editorChanged = new Emitter<void>();
	const documentContent = observableValue('document content', true);
	const parts = { editor: false, auxiliarybar: true };
	const filesDetails = { isEditorVisible: false, onDidChangeDetailsVisibility: Event.None };
	const effects: string[] = [];
	const pending = new DeferredPromise<void>();
	const started = new DeferredPromise<void>();
	let queue = Promise.resolve();
	let supportsDetails = true;
	let changesVisible = false;
	const context: IDesktopLayoutContext = {
		isSessionContent: true,
		sessionEditorRestorationEnabled: observableValue('restoreEditors', true),
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
	assert.deepEqual(headerActions().map(action => action.id), ['ash.sessions.maximizeTool', 'ash.sessions.toggleDetails', 'ash.sessions.hideTool']);
	contextKeys.setContext('sessions.editorToolMaximized', true);
	assert.equal(headerActions()[0]?.label, 'Restore Tool Size');
	assert.equal(headerActions()[0]?.checked, true);
	contextKeys.setContext('sessions.editorToolMaximized', false);
	const desktopIds = () => desktopTitle.getActions().flatMap(([, actions]) => actions).map(action => action.id);
	assert.deepEqual(desktopIds(), title.getActions().flatMap(([, actions]) => actions).map(action => action.id));
	contextKeys.setContext('sessions.editorTool', 'changes');
	contextKeys.setContext('sessions.changes.hasWorkspace', true);
	contextKeys.setContext('sessions.changes.scope', 'all');
	contextKeys.setContext('multiDiffEditorFileListAvailable', true);
	contextKeys.setContext('multiDiffEditorFileListEnabled', true);
	assert.equal(headerActions().find(action => action.id === 'multiDiffEditor.toggleFileList')?.checked, true);
	assert.ok(!headerActions().some(action => action.id === 'ash.sessions.changes.createPullRequest'));
	assert.ok(desktopIds().includes('ash.sessions.changes.previewCommit'));
	using changesScopes = menus.createMenu(Menus.SessionsChangesScope);
	assert.ok(changesScopes.getActions().flatMap(([, actions]) => actions).some(action => action.id === 'ash.sessions.changesScope.turn'));
	flatLayout.set(false);
	assert.equal(headerActions().find(action => action.id === 'multiDiffEditor.toggleFileList')?.checked, true);
	assert.ok(desktopIds().includes('ash.sessions.changes.previewCommit'));
	for (const layout of [true, false]) {
		flatLayout.set(layout);
		for (const [scope, canPreview] of [['all', true], ['turn', true], ['uncommitted', false], ['branch', false]] as const) {
			contextKeys.setContext('sessions.changes.scope', scope);
			assert.equal(desktopIds().includes('ash.sessions.changes.previewCommit'), canPreview);
		}
	}
	contextKeys.setContext('sessions.changes.scope', 'all');
	flatLayout.set(true);
	contextKeys.setContext('sessions.editorTool', 'files');
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
	contextKeys.setContext('sessions.editorTool', 'changes');
	assert.ok(!desktopIds().includes('ash.sessions.toggleDetails'));
	assert.ok(!desktopIds().includes('ash.sessions.hideEditor'));
	flatLayout.set(false);
	assert.ok(!headerActions().some(action => action.id === 'ash.sessions.toggleChangesFileList'));
	assert.equal(headerActions().find(action => action.id === 'multiDiffEditor.toggleFileList')?.checked, true);
	flatLayout.set(true);
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
	contextKeys.setContext('sessions.editorTool', 'terminal');
	assert.deepEqual(headerActions().map(action => action.id), ['ash.sessions.maximizeTool', 'ash.sessions.hideTool']);
	assert.ok(!desktopIds().includes('workbench.action.terminal.selectDefaultProfile'));
	assert.ok(!desktopIds().includes('ash.sessions.configureTerminal'));
	assert.ok(!desktopIds().includes('ash.sessions.closeTerminalPane'));
	const [unavailableSplit, unavailableClear, unavailableBlink] = desktopTitle.getActions().find(([group]) => group === '1_terminal')?.[1] ?? [];
	assert.ok(unavailableSplit instanceof SubmenuItemAction);
	assert.equal(unavailableSplit.actions.length, 4);
	assert.ok(unavailableSplit.actions.every(action => !action.enabled), 'an unavailable shell cannot be split');
	assert.equal(unavailableClear?.enabled, false);
	assert.equal(unavailableBlink?.enabled, true);
	assert.ok(desktopIds().includes('ash.sessions.toggleTerminalCursorBlinking'), 'an unavailable terminal still has More Actions');
	contextKeys.setContext('sessions.editorTool', 'files');
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
		assert.deepEqual(headerActions().map(action => action.label), ['最大化工具窗格', '切换详情', '隐藏工具区域']);
		contextKeys.setContext('sessions.editorToolMaximized', true);
		assert.equal(headerActions()[0]?.label, '还原工具窗格大小');
		contextKeys.setContext('sessions.editorToolMaximized', false);
		assert.deepEqual(addTab.getActions(), []);
		assert.equal(palette.getActions().flatMap(([, actions]) => actions).find(action => action.id === NEW_FILE_TAB_COMMAND_ID)?.label, '打开文件');
		assert.equal(changesAction().label, '更改');
		contextKeys.setContext('sessions.editorTool', 'terminal');
		assert.deepEqual(headerActions().map(action => action.label), ['最大化工具窗格', '隐藏工具区域']);
		contextKeys.setContext('terminalEditorCanSplit', true);
		const split = desktopTitle.getActions().flatMap(([, actions]) => actions)
			.find(action => action instanceof SubmenuItemAction && action.item.submenu === Menus.SessionsTerminalSplit);
		assert.ok(split instanceof SubmenuItemAction);
		assert.deepEqual(split.actions.map(action => action.label), ['上', '下', '左', '右']);
		assert.deepEqual(desktopTitle.getActions().find(([group]) => group === '1_terminal')?.[1].map(action => action.label),
			['拆分', '清屏', '光标闪烁']);
	} finally {
		resetNlsResolver();
	}
});

test('the Flat Terminal title splits the selected shell within its terminal tab', async () => {
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using commands = new CommandService(services);
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const flat = SessionsFlatLayoutContext.bindTo(contextKeys);
	flat.set(true);
	contextKeys.setContext('sessions.editorTool', 'terminal');
	contextKeys.setContext('appServerAvailable', true);
	contextKeys.setContext('terminalEditorCanSplit', true);
	services.registerInstance(IContextKeyService, contextKeys);
	const input = new TerminalEditorInput(URI.parse('vscode-terminal:/test/1'));
	const source = { id: 1, activeInput: input, inputs: [input], selectedInputs: [input] };
	services.registerInstance(IEditorGroupsService, { getGroup: () => source } as unknown as IEditorGroupsService);
	services.registerInstance(ILayoutService, { isPartVisible: () => false, onDidLayoutMainContainer: Event.None } as unknown as IAgentWorkbenchLayoutService);
	services.registerInstance(IEditorPart, { groups: [source], onDidChangeEditors: Event.None, filesPart: { onDidChangeDetailsVisibility: Event.None } } as unknown as IEditorPart);
	const paneSplits: Direction[] = [];
	services.registerInstance(ITerminalEditorService, {
		async splitPane(source: TerminalEditorInput, preserveFocus: boolean, direction: Direction) {
			assert.equal(source, input);
			assert.equal(preserveFocus, false);
			paneSplits.push(direction);
		},
	} as ITerminalEditorService);
	using contribution = services.createInstance(EditorTitleMenuBridgeContribution, { supportsDetails: true }, {
		isDocumentContent: true,
		documentContent: observableValue('document content', true),
	});
	const menus = new MenuService(commands, contextKeys);
	using title = menus.createMenu(Menus.SessionsEditorTitle);
	const groupActions = (group: string) => title.getActions({ arg: { groupId: source.id } }).find(([name]) => name === group)?.[1] ?? [];
	const toolbarSplit = () => groupActions('navigation').find(action => action instanceof SubmenuItemAction && action.item.submenu === Menus.SessionsTerminalSplit);
	assert.equal(toolbarSplit(), undefined);
	const [overflowSplit, clear, blink] = groupActions('1_terminal');
	assert.ok(overflowSplit instanceof SubmenuItemAction && !overflowSplit.item.isSplitButton);
	assert.deepEqual(groupActions('1_terminal').map(action => action.label), ['Split', 'Clear', 'Cursor Blink']);
	assert.deepEqual(overflowSplit.actions.map(action => action.label), ['Up', 'Down', 'Left', 'Right']);
	assert.ok(overflowSplit.actions.every(action => action.enabled));
	assert.ok([...groupActions('1_terminal'), ...overflowSplit.actions].every(action => action.icon === undefined));
	assert.equal(clear?.id, 'ash.sessions.clearTerminal');
	assert.equal(clear.enabled, true);
	assert.equal(blink?.id, 'ash.sessions.toggleTerminalCursorBlinking');
	for (const action of overflowSplit.actions) await action.run();
	assert.deepEqual(paneSplits, [Direction.Up, Direction.Down, Direction.Left, Direction.Right]);

	assert.equal(blink?.checked, false);
	await blink?.run();
	assert.equal(configuration.getValue('sessions.terminal.cursorBlinking'), true);
	assert.equal(configuration.getValue('terminal.integrated.cursorBlinking'), false);
	assert.equal(groupActions('1_terminal').at(-1)?.checked, true);
	await configuration.updateValue('sessions.terminal.cursorBlinking', false);
	assert.equal(groupActions('1_terminal').at(-1)?.checked, false);
	flat.set(false);
	assert.deepEqual(groupActions('1_terminal'), []);
	const split = toolbarSplit();
	assert.ok(split instanceof SubmenuItemAction && split.item.isSplitButton);
	assert.deepEqual(split.actions.map(action => action.label), ['Split Down', 'Split Up', 'Split Left', 'Split Right']);
	await split.actions[0]!.run();
	assert.equal(paneSplits.at(-1), Direction.Down);
});

test('Word Wrap in Files updates the Agents Window preference and reflects the effective setting', async () => {
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using commands = new CommandService(services);
	contextKeys.setContext('sessions.desktopCode', true);
	contextKeys.setContext('sessions.editorTool', 'files');
	contextKeys.setContext('activeEditor', CODE_EDITOR_ID);
	contextKeys.setContext('config.editor.wordWrap', 'bounded');
	const writes: [string, unknown][] = [];
	services.registerInstance(IConfigurationService, {
		getValue: () => contextKeys.getValue('config.editor.wordWrap'),
		updateValue: async (key: string, value: unknown) => {
			writes.push([key, value]);
			assert.equal(typeof value, 'string');
			contextKeys.setContext('config.editor.wordWrap', String(value));
		},
	} as IConfigurationService);
	const menus = new MenuService(commands, contextKeys);
	using title = menus.createMenu(Menus.SessionsEditorTitle);
	const wordWrap = () => title.getActions().flatMap(([, actions]) => actions)
		.find(action => action.id === 'workbench.action.agentSessions.toggleEditorWordWrap');
	assert.equal(wordWrap()?.checked, true);
	await wordWrap()?.run();
	assert.equal(wordWrap()?.checked, false);
	await wordWrap()?.run();
	assert.deepEqual(writes, [['sessions.editor.wordWrap', 'off'], ['sessions.editor.wordWrap', 'on']]);
	contextKeys.setContext('sessions.editorTool', 'changes');
	assert.equal(wordWrap(), undefined);
});
