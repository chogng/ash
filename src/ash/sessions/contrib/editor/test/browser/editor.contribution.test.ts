import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import '../../../../../workbench/contrib/terminal/common/terminalConfiguration.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { autorun, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MenuId, MenusRegistry, SubmenuItemAction } from '../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { CODE_EDITOR_ID } from '../../../../../workbench/browser/parts/editor/textResourceEditor.js';
import { ActiveEditorContext, AppServerAvailableContext, IsSessionsWindowContext, ResourceSchemeContext, SessionsCodeEditorContext } from '../../../../../workbench/common/contextkeys.js';
import { IChatAttachmentResolveService } from '../../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { ITerminalEditorService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalCommandId } from '../../../../../workbench/contrib/terminal/common/terminal.js';
import { TerminalEditorInput } from '../../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { Direction } from '../../../../../base/browser/ui/grid/grid.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import type { ChatContextAttachment } from '../../../../../workbench/services/chat/common/chatContextService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { registerDesktopEditorLayoutActions } from '../../../../browser/layoutActions.js';
import { Menus, SessionsFlatLayoutContext } from '../../../../browser/menus.js';
import { SessionsEditorToolContext } from '../../../../common/contextkeys.js';
import type { EditorParts } from '../../../../browser/parts/editorParts.js';
import type { SessionsPart } from '../../../../browser/parts/sessionsPart.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../../../workbench/contrib/sessions/common/sessionCommands.js';
import type { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import type { DesktopLayoutController, IDesktopLayoutContext } from '../../../layout/browser/desktopLayoutController.js';
import { registerChangesEditorTitleActions } from '../../../changes/browser/changesActions.js';
import { registerSessionsTerminalTitleActions } from '../../../terminal/browser/sessionsTerminalContribution.js';
import { EditorTitleMenuBridgeContribution, registerAddFileAsContextAction, registerSessionsModalEditorActions } from '../../browser/editor.contribution.js';

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

test('the startup contribution projects shared editor commands and submenus until the window closes', () => {
	using services = new InstantiationService();
	using contribution = WorkbenchContributionsRegistry.createHost(
		services, error => { throw error; }, [EditorTitleMenuBridgeContribution.ID],
	);
	const submenu = MenuId.for('test.sessions.editorTitleSubmenu');
	const shared = { command: { id: 'test.sessions.sharedEditorCommand', title: 'Shared editor command' } };
	const excluded = { command: { id: 'workbench.action.splitEditor', title: 'Split editor' } };
	const dynamic = { submenu, title: 'Dynamic editor submenu', group: 'navigation' };
	using initialPlacements = MenusRegistry.appendMenuItems([
		{ id: MenuId.EditorTitle, item: shared },
		{ id: MenuId.EditorTitle, item: excluded },
	]);
	const projected = () => MenusRegistry.getMenuItems(Menus.SessionsEditorTitle);
	assert.ok(!projected().includes(shared));
	contribution.advance(WorkbenchPhase.BlockStartup);
	assert.ok(projected().includes(shared));
	assert.ok(!projected().includes(excluded));
	using submenuPlacement = MenusRegistry.appendMenuItem(MenuId.EditorTitle, dynamic);
	assert.ok(projected().includes(dynamic));
	submenuPlacement.dispose();
	assert.ok(!projected().includes(dynamic));
	assert.ok(projected().includes(shared));
	contribution.dispose();
	assert.ok(!projected().includes(shared));
	assert.ok(MenusRegistry.getMenuItems(MenuId.EditorTitle).includes(shared));
});

test('editor contributions follow layout state, serialize Add Tab commands and release window registrations', async () => {
	using services = new InstantiationService();
	using contextKeys = new ContextKeyService();
	using configuration = new InMemoryConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const flatLayout = SessionsFlatLayoutContext.bindTo(contextKeys);
	flatLayout.set(true);
	const editorTool = SessionsEditorToolContext.bindTo(contextKeys);
	editorTool.set('files');
	using commands = new CommandService(services);
	using layoutChanged = new Emitter<void>();
	using editorChanged = new Emitter<void>();
	const documentContent = observableValue('document content', true);
	const codeEditor = SessionsCodeEditorContext.bindTo(contextKeys);
	using entryContext = autorun(reader => codeEditor.set(documentContent.read(reader)));
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
		isConversationEditorGroup: () => false,
		isActiveConversationEditorGroup: () => false,
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
	} as unknown as DesktopLayoutController;
	const layout = {
		isPartVisible: (part: keyof typeof parts) => parts[part],
		onDidLayoutMainContainer: layoutChanged.event,
	} as unknown as IAgentWorkbenchLayoutService;
	const editor = {
		onDidChangeEditors: editorChanged.event, filesPart: filesDetails,
		groups: [{ id: 2, activeInput: { resource: URI.parse('ash-session-changes:/test') } }],
		isGroupVisible() { return changesVisible; },
		get filesDetailsOpen() { return parts.auxiliarybar; },
		get filesDetailsVisible() { return parts.editor && parts.auxiliarybar; },
		get fileEditorsVisible() { return true; },
	} as unknown as EditorParts;
	const menus = new MenuService(commands, contextKeys);
	using addTab = menus.createMenu(Menus.SessionsEditorTabsBarAddTab);
	const addTabLabels = () => addTab.getActions().flatMap(([, actions]) => actions.map(action => action.label));
	using palette = menus.createMenu(MenuId.CommandPalette);
	const paletteIds = () => palette.getActions().flatMap(([, actions]) => actions).map(action => action.id).sort();
	// Shared editor imports may already contribute commands to the same registry.
	const existingPaletteIds = paletteIds();
	const registerEntryActions = () => {
		const registrations = new DisposableStore();
		registrations.add(registerDesktopEditorLayoutActions(controller, context, contextKeys, layout, editor, async () => { effects.push('chat files'); }));
		registrations.add(registerChangesEditorTitleActions(editor));
		registrations.add(registerSessionsTerminalTitleActions(editor, contextKeys, configuration));
		registrations.add(registerSessionsModalEditorActions(editor, () => context.isDocumentContent));
		return registrations;
	};
	using contribution = registerEntryActions();
	using desktopTitle = menus.createMenu(Menus.SessionsEditorTitle);
	using headerLayout = menus.createMenu(Menus.SessionsEditorHeaderLayout);
	using layoutMenu = menus.createMenu(Menus.TitleBarRightLayout);
	assert.ok(!layoutMenu.getActions().flatMap(([, actions]) => actions).some(action => action.id === 'ash.sessions.toggleChanges'));
	contextKeys.setContext('sessions.sessionActivityBarVisible', true);
	using activity = menus.createMenu(Menus.SessionActivityBar);
	const changesAction = () => activity.getActions().flatMap(([, actions]) => actions).find(action => action.id === 'ash.sessions.toggleChanges')!;
	const headerActions = () => headerLayout.getActions().flatMap(([, actions]) => actions);
	assert.equal(CommandsRegistry.getCommand('ash.sessions.maximizeTool'), undefined);
	assert.deepEqual(headerActions().map(action => action.id), ['ash.sessions.toggleDetails']);
	contextKeys.setContext('sessions.editorHasMultipleTools', true);
	assert.deepEqual(headerActions().map(action => action.id), ['ash.sessions.toggleDetails', 'ash.sessions.hideTool']);
	const desktopIds = () => desktopTitle.getActions().flatMap(([, actions]) => actions).map(action => action.id);
	assert.deepEqual(desktopTitle.getActions().find(([group]) => group === '9_layout')?.[1].map(action => action.id),
		['ash.sessions.toggleDetails', 'ash.sessions.showEditor']);
	assert.ok(!MenusRegistry.getMenuItems(MenuId.EditorTitle).some(item => 'command' in item && item.command.id === 'ash.sessions.toggleDetails'));
	ActiveEditorContext.bindTo(contextKeys).set('ash.sessions.changesEditor');
	ResourceSchemeContext.bindTo(contextKeys).set('ash-session-changes');
	contextKeys.setContext('sessions.changes.hasWorkspace', true);
	contextKeys.setContext('sessions.changes.scope', 'all');
	assert.ok(!desktopIds().includes('ash.sessions.changes.previewCommit'));
	contextKeys.setContext('sessions.changes.canPreviewCommit', true);
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
			contextKeys.setContext('sessions.changes.canPreviewCommit', false);
			assert.ok(!desktopIds().includes('ash.sessions.changes.previewCommit'));
			contextKeys.setContext('sessions.changes.canPreviewCommit', true);
		}
	}
	contextKeys.setContext('sessions.changes.scope', 'all');
	flatLayout.set(true);
	ActiveEditorContext.bindTo(contextKeys).reset();
	ResourceSchemeContext.bindTo(contextKeys).reset();
	editorTool.set('files');
	const layoutTitleActions = () => desktopTitle.getActions().find(([group]) => group === '9_layout')?.[1] ?? [];
	const titleState = () => layoutTitleActions().map(action => [action.label, action.enabled, action.checked]);
	assert.deepEqual(titleState(), [['Toggle details', true, false], ['Show editor', true, undefined]]);
	assert.deepEqual(addTabLabels(), ['Open Files', 'Open Changes']);
	const appServerAvailable = AppServerAvailableContext.bindTo(contextKeys);
	appServerAvailable.set(true);
	assert.deepEqual(addTabLabels(), ['Open Files', 'Open Changes', 'New Terminal']);
	assert.equal(addTab.getActions().flatMap(([, actions]) => actions).at(-1)?.id, TerminalCommandId.CreateTerminalEditor);
	appServerAvailable.reset();
	assert.deepEqual(paletteIds(), [
		...existingPaletteIds,
		NEW_FILE_TAB_COMMAND_ID,
		'workbench.agentSessions.action.viewChanges',
		'ash.sessions.toggleDetails',
		'ash.sessions.showEditor',
	].sort());

	await commands.executeCommand('ash.sessions.showEditor');
	assert.deepEqual(titleState(), [['Toggle details', true, true], ['Hide editor', true, undefined]]);
	ActiveEditorContext.bindTo(contextKeys).set('ash.sessions.changesEditor');
	ResourceSchemeContext.bindTo(contextKeys).set('ash-session-changes');
	assert.ok(!desktopIds().includes('ash.sessions.toggleDetails'));
	assert.ok(!desktopIds().includes('ash.sessions.hideEditor'));
	flatLayout.set(false);
	assert.ok(!headerActions().some(action => action.id === 'ash.sessions.toggleChangesFileList'));
	assert.equal(headerActions().find(action => action.id === 'multiDiffEditor.toggleFileList')?.checked, true);
	flatLayout.set(true);
	editorTool.set('terminal');
	assert.ok(!desktopIds().includes('ash.sessions.toggleDetails'));
	assert.ok(!desktopIds().includes('ash.sessions.hideEditor'));
	editorTool.set('files');
	ActiveEditorContext.bindTo(contextKeys).reset();
	ResourceSchemeContext.bindTo(contextKeys).reset();
	await commands.executeCommand('ash.sessions.toggleDetails');
	assert.equal(contextKeys.getValue('sessions.detailsVisible'), false);
	assert.equal(contextKeys.getValue('sessions.filesVisible'), true, 'Files remains selected while its editor is visible without the attached tree');
	supportsDetails = false;
	editorChanged.fire();
	assert.equal(layoutTitleActions().find(action => action.id === 'ash.sessions.toggleDetails')?.enabled, false);
	editorTool.set('terminal');
	assert.deepEqual(headerActions().map(action => action.id), ['ash.sessions.hideTool']);
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
	editorTool.set('files');
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
	assert.equal(changesAction().checked, true, 'Opening Changes elsewhere updates the activity-bar selection');
	parts.editor = false;
	layoutChanged.fire();
	assert.equal(changesAction().checked, false, 'Hiding the editor area clears the activity-bar selection');
	parts.editor = true;
	layoutChanged.fire();
	assert.equal(changesAction().checked, true);
	changesVisible = false;
	editorChanged.fire();
	assert.equal(changesAction().checked, false, 'Closing Changes elsewhere clears the activity-bar selection');
	parts.editor = false;
	layoutChanged.fire();
	documentContent.set(false, undefined);
	assert.deepEqual(headerActions(), []);
	contextKeys.setContext('sessions.chatConversationPage', true);
	assert.deepEqual(headerActions().map(action => action.id), ['ash.sessions.hideTool']);
	contextKeys.setContext('sessions.editorHasMultipleTools', false);
	assert.deepEqual(headerActions(), []);
	assert.deepEqual(addTabLabels(), ['Open Files']);
	await commands.executeCommand(NEW_FILE_TAB_COMMAND_ID);
	assert.equal(effects.pop(), 'chat files');
	contextKeys.setContext('sessions.chatConversationPage', false);
	contextKeys.setContext('sessions.editorHasMultipleTools', true);
	assert.deepEqual(layoutTitleActions(), []);
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
	for (const id of ['toggleDetails', 'hideEditor', 'showEditor', 'toggleChanges']) {
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
		using translated = registerEntryActions();
		assert.deepEqual(titleState().map(([label]) => label), ['切换详情', '显示编辑器']);
		assert.deepEqual(headerActions().map(action => action.label), ['切换详情', '隐藏工具区域']);
		appServerAvailable.set(true);
		assert.deepEqual(addTabLabels(), ['打开文件', '打开更改', '新建终端']);
		appServerAvailable.reset();
		assert.equal(palette.getActions().flatMap(([, actions]) => actions).find(action => action.id === NEW_FILE_TAB_COMMAND_ID)?.label, '打开文件');
		contextKeys.setContext('sessions.sessionActivityBarVisible', true);
		assert.equal(changesAction().label, '更改');
		editorTool.set('terminal');
		assert.deepEqual(headerActions().map(action => action.label), ['隐藏工具区域']);
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
	SessionsEditorToolContext.bindTo(contextKeys).set('terminal');
	contextKeys.setContext('appServerAvailable', true);
	contextKeys.setContext('terminalEditorCanSplit', true);
	SessionsCodeEditorContext.bindTo(contextKeys).set(true);
	services.registerInstance(IContextKeyService, contextKeys);
	const input = new TerminalEditorInput(URI.parse('vscode-terminal:/test/1'));
	const source = { id: 1, activeInput: input, inputs: [input], selectedInputs: [input] };
	services.registerInstance(IEditorGroupsService, { getGroup: () => source } as unknown as IEditorGroupsService);
	const editor = { groups: [source] } as unknown as IEditorPart;
	const paneSplits: Direction[] = [];
	services.registerInstance(ITerminalEditorService, {
		async splitPane(source: TerminalEditorInput, preserveFocus: boolean, direction: Direction) {
			assert.equal(source, input);
			assert.equal(preserveFocus, false);
			paneSplits.push(direction);
		},
	} as ITerminalEditorService);
	using contribution = registerSessionsTerminalTitleActions(editor, contextKeys, configuration);
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
	assert.equal(configuration.getValue('terminal.integrated.cursorBlinking'), true);
	assert.equal(groupActions('1_terminal').at(-1)?.checked, true);
	await configuration.updateValue('terminal.integrated.cursorBlinking', false);
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
	SessionsCodeEditorContext.bindTo(contextKeys).set(true);
	const editorTool = SessionsEditorToolContext.bindTo(contextKeys);
	editorTool.set('files');
	ActiveEditorContext.bindTo(contextKeys).set(CODE_EDITOR_ID);
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
	ActiveEditorContext.bindTo(contextKeys).set('ash.sessions.changesEditor');
	ResourceSchemeContext.bindTo(contextKeys).set('ash-session-changes');
	assert.equal(wordWrap(), undefined);
});
