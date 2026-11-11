import { isCancellationError } from '../../../../base/common/errors.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Direction } from '../../../../base/browser/ui/grid/grid.js';
import { Schemas } from '../../../../base/common/network.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { resolveCommandsContext } from '../../../../workbench/browser/parts/editor/editorCommandsContext.js';
import { ActiveEditorContext, AppServerAvailableContext, EditorGroupEditorsCountContext, EditorPartModalVisibleContext, IsSessionsWindowContext, ResourceSchemeContext } from '../../../../workbench/common/contextkeys.js';
import { CODE_EDITOR_ID } from '../../../../workbench/browser/parts/editor/textResourceEditor.js';
import { IChatAttachmentResolveService } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { ITerminalEditorService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditor } from '../../../../workbench/contrib/terminal/browser/terminalEditor.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { TerminalEditorCanSplitContext } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import type { SessionsPart } from '../../../browser/parts/sessionsPart.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { Action2, MenusRegistry, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import type { DesktopEditorParts } from '../../../browser/parts/desktopEditorParts.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { localize, localize2 } from '../../../../nls.js';
import { EditorToolMaximizedContext, Menus, SessionsFlatLayoutContext, sessionToolMenuItems } from '../../../browser/menus.js';
import { SessionsCategories } from '../../../common/categories.js';
import { SESSIONS_EDITOR_WORD_WRAP, SESSIONS_TERMINAL_CONFIG_SECTION } from '../../../common/configuration.js';
import { IsNewSessionContext, NewSessionHasUsableWorkspaceContext } from '../../../common/contextkeys.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import type { DesktopLayoutController, IDesktopLayoutContext } from '../../layout/browser/desktopLayoutController.js';
import { registerAddTabActions } from './addTabActions.js';
import { ChangesFileListAvailableContext, ChangesFileListVisibleContext, SessionChangesEditor } from '../../changes/browser/sessionChangesEditor.js';
import { isRecord } from '../../../../base/common/types.js';

const editorVisibleContext = new RawContextKey<boolean>('sessions.editorContentVisible', false);
const detailsVisibleContext = new RawContextKey<boolean>('sessions.detailsVisible', false);
const filesVisibleContext = new RawContextKey<boolean>('sessions.filesVisible', false);
const changesVisibleContext = new RawContextKey<boolean>('sessions.changesVisible', false);
const codeContext = new RawContextKey<boolean>('sessions.desktopCode', false);
const supportedDetailsContext = new RawContextKey<boolean>('sessions.supportedDetails', false);
const filesTool = ContextKeyExpr.equals('sessions.editorTool', 'files');
const terminalTool = ContextKeyExpr.equals('sessions.editorTool', 'terminal');
const terminalCursorBlinkingSetting = `${SESSIONS_TERMINAL_CONFIG_SECTION}.cursorBlinking`;
const terminalCursorBlinkingContext = new RawContextKey<boolean>('sessions.terminalCursorBlinking', false);

registerAction2(class ToggleSessionsEditorWordWrapAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agentSessions.toggleEditorWordWrap',
			title: localize2('sessions.editor.toggleWordWrap', 'Word Wrap'),
			toggled: ContextKeyExpr.or(...['on', 'bounded', 'wordWrapColumn'].map(value => ContextKeyExpr.equals('config.editor.wordWrap', value))),
			menu: {
				id: Menus.SessionsEditorTitle,
				group: '1_view',
				when: ContextKeyExpr.and(codeContext.isEqualTo(true), filesTool, ActiveEditorContext.isEqualTo(CODE_EDITOR_ID)),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		return configuration.updateValue(SESSIONS_EDITOR_WORD_WRAP, configuration.getValue('editor.wordWrap') === 'off' ? 'on' : 'off');
	}
});

/** Window-owned editor commands and menu state derive from the existing layout owner. */
export class EditorTitleMenuBridgeContribution extends Disposable {
	constructor(
		controller: DesktopLayoutController,
		context: IDesktopLayoutContext,
		@IContextKeyService contextKeys: IContextKeyService,
		@ILayoutService layout: IAgentWorkbenchLayoutService,
		@IEditorPart editor: IEditorPart,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		// Existing editor contributions keep their menu identity; Desktop groups consume its live projection.
		const mirrored = this._register(new DisposableStore());
		const layoutCommands = new Set(['ash.sessions.toggleDetails', 'ash.sessions.hideEditor', 'ash.sessions.showEditor']);
		const excludedCommands = new Set(['multiDiffEditor.goToPreviousChange', 'multiDiffEditor.goToNextChange', 'workbench.action.splitEditor']);
		const updateEditorMenu = (): void => {
			mirrored.clear();
			for (const item of MenusRegistry.getMenuItems(MenuId.EditorTitle)) {
				if ('command' in item && excludedCommands.has(item.command.id)) { continue; }
				// The dedicated layout toolbar owns card controls.
				const layoutItem = 'command' in item && layoutCommands.has(item.command.id);
				mirrored.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, layoutItem ? { ...item, group: '9_layout' } : item));
			}
		};
		this._register(MenusRegistry.onDidChangeMenu(event => {
			if (event.has(MenuId.EditorTitle)) { updateEditorMenu(); }
		}));
		updateEditorMenu();
		const editorVisible = editorVisibleContext.bindTo(contextKeys);
		const detailsVisible = detailsVisibleContext.bindTo(contextKeys);
		const fileEditorsVisible = filesVisibleContext.bindTo(contextKeys);
		const changesVisible = changesVisibleContext.bindTo(contextKeys);
		const code = codeContext.bindTo(contextKeys);
		const supportedDetails = supportedDetailsContext.bindTo(contextKeys);
		const updateContext = (): void =>
			contextKeys.bufferChangeEvents(() => {
				code.set(context.isDocumentContent);
				editorVisible.set(context.isDocumentContent && layout.isPartVisible('editor') &&
					(!(editor as DesktopEditorParts).filesDetailsVisible || (editor as DesktopEditorParts).filesPart.isEditorVisible));
				detailsVisible.set(context.isDocumentContent && layout.isPartVisible('editor') && (editor as DesktopEditorParts).filesDetailsVisible);
				fileEditorsVisible.set(context.isDocumentContent && layout.isPartVisible('editor') && (editor as DesktopEditorParts).fileEditorsVisible);
				changesVisible.set(context.isDocumentContent && layout.isPartVisible('editor') && editor.groups.some(group =>
					editor.isGroupVisible(group.id) && group.activeInput?.resource.scheme === 'ash-session-changes'));
				supportedDetails.set(context.isDocumentContent && controller.supportsDetails);
			});
		this._register(
			toDisposable(() => {
				for (const key of [editorVisible, detailsVisible, fileEditorsVisible, changesVisible, code, supportedDetails]) {
					key.reset();
				}
			}),
		);
		this._register(layout.onDidLayoutMainContainer(updateContext));
		this._register(editor.onDidChangeEditors(updateContext));
		this._register((editor as DesktopEditorParts).filesPart.onDidChangeDetailsVisibility(updateContext));
		this._register(
			autorun(reader => {
				context.documentContent.read(reader);
				updateContext();
			}),
		);
		const run = (operation: () => Promise<void>): Promise<void> | false =>
			context.isDocumentContent &&
			context.runOperation(async () => {
				await operation();
				updateContext();
			});
		const toolGroup = (arg: unknown): number => isRecord(arg) && typeof arg.groupId === 'number'
			&& editor.groups.some(group => group.id === arg.groupId) ? arg.groupId : editor.activeGroup.id;
		const terminalInCode = ContextKeyExpr.and(codeContext.isEqualTo(true), terminalTool);
		const liveShell = TerminalEditorCanSplitContext.isEqualTo(true);
		const appServerAvailable = AppServerAvailableContext.isEqualTo(true);
		const canSplit = ContextKeyExpr.and(liveShell, appServerAvailable);
		const flatLayout = SessionsFlatLayoutContext.isEqualTo(true);
		const modernLayout = ContextKeyExpr.not(SessionsFlatLayoutContext.key);
		const flatTerminal = ContextKeyExpr.and(terminalInCode, flatLayout);
		this._register(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
			submenu: Menus.SessionsTerminalSplit,
			title: localize2('terminal.group.splitMenu', 'Split Terminal'),
			isSplitButton: true,
			when: ContextKeyExpr.and(terminalInCode, liveShell, modernLayout),
			group: 'navigation',
		}));
		for (const [order, [id, direction, title, modernTitle, icon, modernOrder]] of ([
			['ash.sessions.splitTerminalUp', Direction.Up, localize2('sessions.terminal.menu.up', 'Up'), localize2('workbench.splitEditorUp', 'Split Up'), Lxicon.splitVertical, 1],
			['ash.sessions.splitTerminalDown', Direction.Down, localize2('sessions.terminal.menu.down', 'Down'), localize2('workbench.splitEditorDown', 'Split Down'), Lxicon.splitVertical, 0],
			['ash.sessions.splitTerminalLeft', Direction.Left, localize2('sessions.terminal.menu.left', 'Left'), localize2('workbench.splitEditorLeft', 'Split Left'), Lxicon.splitHorizontal, 2],
			['ash.sessions.splitTerminalRight', Direction.Right, localize2('sessions.terminal.menu.right', 'Right'), localize2('workbench.splitEditorRight', 'Split Right'), Lxicon.splitHorizontal, 3],
		] as const).entries()) {
			this._register(CommandsRegistry.register(id, async (accessor, ...args) => {
				const { groupedEditors: [source], preserveFocus } = resolveCommandsContext(args, accessor.get(IEditorGroupsService));
				const input = source?.group.activeInput;
				if (input instanceof TerminalEditorInput) await accessor.get(ITerminalEditorService).splitPane(input, preserveFocus, direction);
			}));
			this._register(MenusRegistry.appendMenuItems([
				{ id: Menus.SessionsTerminalSplit, item: { command: { id, title, precondition: canSplit }, when: flatLayout, order } },
				{ id: Menus.SessionsTerminalSplit, item: { command: { id, title: modernTitle, icon, precondition: appServerAvailable }, when: modernLayout, order: modernOrder } },
			]));
		}
		this._register(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
			submenu: Menus.SessionsTerminalSplit, title: localize2('workbench.splitMenu', 'Split'), when: flatTerminal, group: '1_terminal', order: 0,
		}));
		this._register(CommandsRegistry.register('ash.sessions.clearTerminal', (accessor, ...args) => {
			const { groupedEditors: [source] } = resolveCommandsContext(args, accessor.get(IEditorGroupsService));
			const pane = editor.groups.find(group => group.id === source?.group.id)?.activePane;
			if (pane instanceof TerminalEditor) pane.getControl()?.clearBuffer();
		}));
		this._register(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
			command: { id: 'ash.sessions.clearTerminal', title: localize2('sessions.terminal.menu.clear', 'Clear'), precondition: liveShell },
			when: flatTerminal, group: '1_terminal', order: 1,
		}));
		const cursorBlinking = terminalCursorBlinkingContext.bindTo(contextKeys);
		const updateCursorBlinking = () => cursorBlinking.set(configuration.getValue<boolean>(terminalCursorBlinkingSetting) === true);
		updateCursorBlinking();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(terminalCursorBlinkingSetting)) updateCursorBlinking();
		}));
		this._register(toDisposable(() => cursorBlinking.reset()));
		this._register(CommandsRegistry.register('ash.sessions.toggleTerminalCursorBlinking', () =>
			configuration.updateValue(terminalCursorBlinkingSetting, !configuration.getValue<boolean>(terminalCursorBlinkingSetting))));
		this._register(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
			command: {
				id: 'ash.sessions.toggleTerminalCursorBlinking',
				title: localize2('sessions.terminal.menu.cursorBlink', 'Cursor Blink'),
				toggled: terminalCursorBlinkingContext.isEqualTo(true),
			},
			when: flatTerminal, group: '1_terminal', order: 2,
		}));
		this._register(CommandsRegistry.register('ash.sessions.toggleChangesFileList', (_accessor, arg) => {
			const pane = editor.groups.find(group => group.id === toolGroup(arg))?.activePane;
			if (pane instanceof SessionChangesEditor) { pane.toggleFileList(); }
		}));
		const hideToolId = 'ash.sessions.hideTool';
		this._register(CommandsRegistry.register(hideToolId, (_accessor, arg) => run(async () => {
			const groupId = isRecord(arg) && typeof arg.groupId === 'number' ? arg.groupId : editor.activeGroup.id;
			if (!editor.groups.some(group => group.id === groupId)) return;
			(editor as DesktopEditorParts).hideTool(groupId);
			if (editor.groups.every(group => !editor.isGroupVisible(group.id))) layout.hidePart('editor');
		})));
		this._register(CommandsRegistry.register('ash.sessions.maximizeTool', (_accessor, arg) => run(async () => {
			(editor as DesktopEditorParts).toggleMaximizeTool(toolGroup(arg));
		})));
		for (const [id, operation] of [
			['ash.sessions.toggleDetails', () => controller.toggleDetails()],
			['ash.sessions.toggleFiles', () => controller.toggleFiles()],
			['ash.sessions.toggleChanges', () => controller.toggleChanges()],
			[
				'ash.sessions.closeDetails',
				async () => {
					if ((editor as DesktopEditorParts).filesDetailsOpen) { await controller.toggleDetails(); }
				},
			],
			['ash.sessions.hideEditor', () => controller.hideEditor()],
			['ash.sessions.showEditor', () => controller.showEditor()],
			['ash.sessions.toggleSidePane', () => controller.toggleSidePane()],
		] as const) {
			this._register(CommandsRegistry.register(id, () => run(operation)));
		}
		this._register(
			registerAddTabActions(
				() => run(() => controller.openFiles()),
				() => run(() => controller.openChanges()),
				codeContext.isEqualTo(true),
			),
		);
		const codeWhen = codeContext.isEqualTo(true);
		const modalVisible = EditorPartModalVisibleContext.isEqualTo(true);
		const modalToEditor = ContextKeyExpr.and(codeWhen, modalVisible);
		this._register(registerAction2(class OpenModalEditorInEditorAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.agentSessions.openModalEditorInEditor',
					title: localize2({ bundle: 'ash.workbench', key: 'sessions.editor.openModalInEditor' }, 'Open in Editor Area'),
					icon: Lxicon.linkExternal,
					precondition: modalToEditor,
					menu: { id: MenuId.ModalEditorTitle, group: 'navigation', order: 98, when: modalToEditor },
				});
			}
			override run(): Promise<void> { return (editor as DesktopEditorParts).moveModalEditorToMain(); }
		}));
		const openInModal = ContextKeyExpr.and(codeWhen, EditorPartModalVisibleContext.isEqualTo(false),
			ContextKeyExpr.or(...[Schemas.file, Schemas.ashRemote, Schemas.untitled, 'ash-session-changes'].map(scheme => ResourceSchemeContext.isEqualTo(scheme))));
		this._register(registerAction2(class OpenActiveEditorInModalAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.agentSessions.openEditorInModal',
					title: localize2({ bundle: 'ash.workbench', key: 'sessions.editor.openInModal' }, 'Open in Modal Editor'),
					f1: true,
					precondition: openInModal,
				});
			}
			override run(): Promise<void> { return (editor as DesktopEditorParts).openActiveEditorInModal(); }
		}));
		const editorShown = ContextKeyExpr.and(codeWhen, editorVisibleContext.isEqualTo(true));
		const editorHidden = ContextKeyExpr.and(codeWhen, editorVisibleContext.isEqualTo(false));
		const toggleSidePane = {
			id: 'ash.sessions.toggleSidePane',
			title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleSidePane' }, 'Toggle Code side panel'),
			toggled: ContextKeyExpr.or(editorVisibleContext.isEqualTo(true), detailsVisibleContext.isEqualTo(true)),
		};
		const toggleDetails = {
			id: 'ash.sessions.toggleDetails',
			title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleDetails' }, 'Toggle details'),
			toggled: detailsVisibleContext.isEqualTo(true),
			precondition: supportedDetailsContext.isEqualTo(true),
		};
		const hideEditor = {
			id: 'ash.sessions.hideEditor',
			title: localize2({ bundle: 'ash', key: 'sessions.layout.hideEditor' }, 'Hide editor'),
		};
		const showEditor = {
			id: 'ash.sessions.showEditor',
			title: localize2({ bundle: 'ash', key: 'sessions.layout.showEditor' }, 'Show editor'),
		};
		this._register(
			MenusRegistry.appendMenuItems([
				{
					id: Menus.SessionsEditorHeaderLayout,
					item: {
						command: { ...toggleDetails, icon: Lxicon.listUnordered },
						when: ContextKeyExpr.and(codeWhen, filesTool),
						group: 'navigation',
						order: 2,
					},
				},
				{
					id: Menus.SessionsEditorHeaderLayout,
					item: {
						command: {
							id: 'ash.sessions.toggleChangesFileList',
							title: localize2({ bundle: 'ash', key: 'sessions.changes.toggleFileList' }, 'Toggle changed files list'),
							icon: Lxicon.listUnordered,
							toggled: ChangesFileListVisibleContext.isEqualTo(true),
						},
						when: ContextKeyExpr.and(codeWhen, ContextKeyExpr.equals('sessions.editorTool', 'changes'), ChangesFileListAvailableContext.isEqualTo(true)),
						group: 'navigation',
						order: 2,
					},
				},
				{
					id: Menus.SessionsEditorHeaderLayout,
					item: {
						command: {
							id: 'ash.sessions.maximizeTool',
							title: localize2('sessions.layout.maximizeTool', 'Maximize Tool'),
							icon: Lxicon.screenFull,
							toggled: {
								condition: EditorToolMaximizedContext.isEqualTo(true),
								title: localize2('sessions.layout.restoreTool', 'Restore Tool Size'),
								icon: Lxicon.screenNormal,
							},
						},
						when: codeWhen, group: 'navigation', order: 1,
					},
				},
				{
					id: Menus.SessionsEditorHeaderLayout,
					item: {
						command: { id: hideToolId, title: localize2('sessions.layout.hideTool', 'Hide tool'), icon: Lxicon.close },
						when: codeWhen, group: 'navigation', order: 3,
					},
				},
				{
					id: MenuId.AuxiliaryBarTitle,
					item: {
						command: {
							id: 'ash.sessions.closeDetails',
							title: localize2({ bundle: 'ash', key: 'sessions.layout.closeDetails' }, 'Close details'),
							icon: Lxicon.close,
						},
						when: codeWhen,
						group: 'navigation',
						order: 100,
					},
				},
				...sessionToolMenuItems({
					command: {
						id: 'ash.sessions.toggleFiles',
						title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleFiles' }, 'Toggle files'),
						icon: Lxicon.folder,
						toggled: filesVisibleContext.isEqualTo(true),
					},
					when: ContextKeyExpr.and(codeWhen, ContextKeyExpr.or(
						IsNewSessionContext.isEqualTo(false),
						NewSessionHasUsableWorkspaceContext.isEqualTo(true),
					)),
					group: 'navigation',
					order: 5,
				}),
				...sessionToolMenuItems({
					command: {
						id: 'ash.sessions.toggleChanges',
						title: localize2({ bundle: 'ash', key: 'sessions.changes.title' }, 'Changes'),
						icon: Lxicon.diffChanges,
						toggled: changesVisibleContext.isEqualTo(true),
					},
					when: ContextKeyExpr.and(codeWhen, ContextKeyExpr.not(IsNewSessionContext.key)),
					group: 'navigation',
					order: 4,
				}),
				{
					id: MenuId.EditorTitle,
					item: {
						command: { ...toggleDetails, icon: Lxicon.listUnordered },
						when: ContextKeyExpr.and(codeWhen, filesTool),
						group: 'navigation',
						order: 90,
					},
				},
				{
					id: MenuId.EditorTitle,
					item: {
						command: { ...hideEditor, icon: Lxicon.layoutSidebarRightOffSession },
						when: ContextKeyExpr.and(editorShown, filesTool),
						group: 'navigation',
						order: 91,
					},
				},
				{
					id: MenuId.EditorTitle,
					item: {
						command: { ...showEditor, icon: Lxicon.layoutSidebarRightSession },
						when: ContextKeyExpr.and(editorHidden, filesTool),
						group: 'navigation',
						order: 91,
					},
				},
			]),
		);
		const codeLayoutCommands = [
			{ command: toggleSidePane, when: codeWhen, order: 0 },
			{ command: toggleDetails, when: codeWhen, order: 1 },
			{ command: hideEditor, when: editorShown, order: 2 },
			{ command: showEditor, when: editorHidden, order: 2 },
		];
		this._register(
			MenusRegistry.appendMenuItems(
				codeLayoutCommands.flatMap(item =>
					[MenuId.CommandPalette, MenuId.MenubarViewMenu].map(id => ({
						id,
						item: { ...item, group: '2_code_layout' },
					})),
				),
			),
		);
		updateContext();
	}
}


/** Adds the selected editor contents to the draft that was active when invoked. */
export function registerAddFileAsContextAction(sessions: SessionsPart) {
	const schemes: ReadonlySet<string> = new Set([Schemas.file, Schemas.ashRemote, Schemas.untitled]);
	const when = ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ContextKeyExpr.notEquals('config.chat.disableAIFeatures', true),
		ContextKeyExpr.or(...Array.from(schemes, scheme => ResourceSchemeContext.isEqualTo(scheme))));
	return registerAction2(class AddFileAsContextAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.agentSessions.addFileAsContext',
				title: localize2({ bundle: 'ash.workbench', key: 'sessions.editor.addFileAsContext' }, 'Add File as Context'),
				category: SessionsCategories.Sessions,
				icon: Lxicon.paperclip,
				f1: true,
				precondition: when,
				menu: [
					{ id: Menus.SessionsEditorTitle, when, group: 'navigation', order: 100 },
					{ id: MenuId.EditorTitleContext, when, group: 'z_chat' },
				],
			});
		}

		override async run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
			const { groupedEditors } = resolveCommandsContext(args, accessor.get(IEditorGroupsService));
			const inputs = groupedEditors.flatMap(({ editors }) => editors).filter(input => schemes.has(input.resource.scheme));
			if (!inputs.length) return;
			const resolver = accessor.get(IChatAttachmentResolveService);
			const accepted = await sessions.acquireContext(async signal => {
				const attachments = await Promise.all(inputs.map(input => resolver.resolveEditorAttachContext(input, signal)));
				return attachments.filter(attachment => attachment !== undefined);
			}).catch(error => {
				if (!isCancellationError(error)) throw error;
				return [];
			});
			if (accepted.length) status(localize({ bundle: 'ash.workbench', key: 'sessions.editor.filesAttached' }, 'Added {0} file(s) to the conversation draft.', accepted.length));
		}
	});
}
