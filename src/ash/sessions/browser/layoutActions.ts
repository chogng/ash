import type { DesktopLayoutController, IDesktopLayoutContext } from '../contrib/layout/browser/desktopLayoutController.js';
import { registerAddTabActions } from '../contrib/editor/browser/addTabActions.js';
import { isRecord } from '../../base/common/types.js';
import { ISessionsEntryService } from '../services/layout/common/sessionsEntryService.js';
import { SessionSideChatEditorInput } from '../contrib/chat/browser/sessionSideChatEditorInput.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import type { EditorParts } from './parts/editorParts.js';
import type { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../nls.js';
import { Lxicon } from '../../base/common/lxicons.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../base/common/observable.js';
import { MenusRegistry, MenuId, Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../platform/commands/common/commands.js';
import { ContextKeyExpr, RawContextKey, type IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import type { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import {
	SideBarVisibleContext,
	SessionsCodeEditorContext,
	PanelVisibleContext,
} from '../../workbench/common/contextkeys.js';
import type { ISessionsService } from '../services/sessions/browser/sessionsService.js';
import type { IAgentWorkbenchLayoutService } from './workbench.js';
import { EditorHasMultipleToolsContext, EditorToolMaximizedContext, Menus, sessionToolMenuItems } from './menus.js';
import { hasSelectedCodeWorkspace } from '../common/sessionWorkspace.js';
import { CanGoBackContext, CanGoForwardContext, ChatConversationPageContext, IsNewSessionContext, NewSessionHasUsableWorkspaceContext, SessionsEditorToolContext } from '../common/contextkeys.js';

const sessionTools = new RawContextKey<boolean>('sessions.toolsAvailable', false);
const sessionsPartHidden = new RawContextKey<boolean>('sessions.sessionPartHidden', false);
const conversationCovered = new RawContextKey<boolean>('sessions.conversationCovered', false);
const showSessionTools = ContextKeyExpr.and(sessionTools.isEqualTo(true), ContextKeyExpr.not(IsNewSessionContext.key));

/** Registers window-local commands and derives their menu state from the layout and session owners. */
export function registerLayoutActions(
	layout: IAgentWorkbenchLayoutService,
	sessions: ISessionsService,
	contextKeys: IContextKeyService,
	editor: EditorParts,
	workspace: IWorkspaceContextService,
	hasDesktopChatSource: IObservable<boolean>,
): IDisposable {
	const disposables = new DisposableStore();
	const sidebarVisible = SideBarVisibleContext.bindTo(contextKeys);
	const backEnabled = CanGoBackContext.bindTo(contextKeys);
	const forwardEnabled = CanGoForwardContext.bindTo(contextKeys);
	const codeAvailable = sessionTools.bindTo(contextKeys);
	const panelVisible = PanelVisibleContext.bindTo(contextKeys);
	const covered = conversationCovered.bindTo(contextKeys);
	const sessionsHidden = sessionsPartHidden.bindTo(contextKeys);
	const isNewSession = IsNewSessionContext.bindTo(contextKeys);
	const hasUsableWorkspace = NewSessionHasUsableWorkspaceContext.bindTo(contextKeys);
	const updateContext = (): void =>
		contextKeys.bufferChangeEvents(() => {
			sidebarVisible.set(layout.isPartVisible('sidebar'));
			sessionsHidden.set(!layout.isPartAvailable('sessions'));
			backEnabled.set(sessions.canNavigateBack);
			forwardEnabled.set(sessions.canNavigateForward);
			codeAvailable.set(contextKeys.getValue(SessionsCodeEditorContext.key) === true);
			panelVisible.set(layout.isPartVisible('panel'));
			covered.set(codeAvailable.get() === true && layout.isPartAvailable('sessions') && !layout.isPartVisible('sessions') && layout.isPartVisible('editor'));
			const selection = sessions.activeSelection;
			isNewSession.set(!hasDesktopChatSource.get() && layout.isPartVisible('sessions') && selection?.kind === 'untitled' && !selection.session.forkSource);
			hasUsableWorkspace.set(selection?.kind === 'untitled' && hasSelectedCodeWorkspace(selection.session)
				&& workspace.getWorkspace().folders.length > 0);
		});
	disposables.add(autorun(reader => {
		hasDesktopChatSource.read(reader);
		updateContext();
	}));
	disposables.add(layout.onDidChangePartVisibility(updateContext));
	disposables.add(editor.onDidChangeEditors(updateContext));
	disposables.add(sessions.onDidChange(updateContext));
	disposables.add(workspace.onDidChangeWorkspace(updateContext));
	disposables.add(layout.onDidLayoutMainContainer(updateContext));
	disposables.add(
		toDisposable(() =>
			contextKeys.bufferChangeEvents(() => {
				sidebarVisible.reset();
				sessionsHidden.reset();
				backEnabled.reset();
				forwardEnabled.reset();
				codeAvailable.reset();
				panelVisible.reset();
				covered.reset();
				isNewSession.reset();
				hasUsableWorkspace.reset();
			}),
		),
	);
	disposables.add(registerAction2(class ToggleSidebarVisibilityAction extends Action2 {
		constructor() {
			super({
				id: 'ash.sessions.toggleSidebar',
				title: localize2({ bundle: 'ash', key: 'sessions.navigation.showSidebar' }, 'Show sidebar'),
				icon: Lxicon.layoutSidebarLeftOff,
				toggled: {
					condition: SideBarVisibleContext.isEqualTo(true),
					title: localize2({ bundle: 'ash', key: 'sessions.navigation.hideSidebar' }, 'Hide sidebar'),
					tooltip: localize2({ bundle: 'ash', key: 'sessions.navigation.hideSidebar' }, 'Hide sidebar'),
					icon: Lxicon.layoutSidebarLeft,
				},
				menu: [
					{ id: Menus.TitleBarLeftLayout, group: 'navigation', order: 0 },
					{ id: Menus.TitleBarContext, group: 'navigation', order: 0 },
				],
			});
		}

		override run(): void {
			if (layout.isPartVisible('sidebar')) {
				layout.hidePart('sidebar');
			} else {
				layout.showPart('sidebar');
			}
		}
	}));
	disposables.add(registerAction2(class ToggleSessionPartAction extends Action2 {
		constructor() {
			super({
				id: 'sessions.toggleSessionPart',
				title: localize2('sessions.layout.maximize', 'Maximize'),
				icon: Lxicon.maximize,
				toggled: {
					condition: sessionsPartHidden.isEqualTo(true),
					title: localize2('sessions.layout.showChat', 'Show Chat'),
					tooltip: localize2('sessions.layout.exitFullScreen', 'Exit Full Screen'),
					icon: Lxicon.minimize,
				},
				menu: [
					{ id: Menus.EditorPartLayout, group: 'navigation', order: 1 },
					{ id: Menus.SessionsEditorHeaderLayout, when: ContextKeyExpr.not(SessionsCodeEditorContext.key), group: 'navigation', order: 1 },
				],
			});
		}

		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(ISessionsEntryService).setConversationVisible(!layout.isPartAvailable('sessions'), { preserveFocus: true });
		}
	}));
	disposables.add(registerAction2(class CloseEditorPartAction extends Action2 {
		constructor() {
			super({
				id: 'sessions.closeEditorPart',
				title: localize2('sessions.layout.closeEditor', 'Close editor'),
				tooltip: localize2('sessions.layout.closeEditorTooltip', 'Close'),
				icon: Lxicon.layoutSidebarRightOff,
				menu: { id: Menus.EditorPartLayout, group: 'navigation', order: 2 },
			});
		}

		override run(): void {
			if (!editor.area.hasProductPage || !layout.isPartVisible('editor')) return;
			layout.updateParts(() => {
				layout.setPartAvailable('sessions', true);
				layout.hidePart('editor');
			});
			layout.focus();
		}
	}));
	disposables.add(CommandsRegistry.register('ash.sessions.back', () => sessions.openPreviousSession()));
	disposables.add(CommandsRegistry.register('ash.sessions.forward', () => sessions.openNextSession()));
	disposables.add(registerAction2(class ShowConversationAction extends Action2 {
		constructor() {
			super({
				id: 'ash.sessions.showConversation',
				title: localize2({ bundle: 'ash', key: 'sessions.layout.showConversation' }, 'Show main conversation'),
				icon: Lxicon.chat,
				f1: true,
				precondition: conversationCovered.isEqualTo(true),
				menu: { id: Menus.TitleBarRightLayout, when: conversationCovered.isEqualTo(true), group: 'navigation', order: 0 },
			});
		}

		override run(): void { if (covered.get()) layout.showPart('sessions'); }
	}));
	disposables.add(registerAction2(class OpenSideChatAction extends Action2 {
		constructor() {
			super({
				id: 'ash.sessions.openSideChat',
				title: localize2({ bundle: 'ash', key: 'sessions.layout.sideChat' }, 'Side Chat'),
				icon: Lxicon.chat,
				precondition: sessionTools.isEqualTo(true),
				menu: { id: Menus.TitleBarRightLayout, when: showSessionTools, group: '1_tools', order: 1 },
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			if (!layout.isPartAvailable('sessions') || layout.isPartVisible('customview') || !codeAvailable.get()) return;
			const management = accessor.get(ISessionsManagementService);
			const title = localize('chat.title.new', 'New Chat');
			// The tool Part chooses its active group. A fresh draft gives each tab its own identity
			// without changing the main Sessions selection.
			const draft = management.createUntitledSession(title, undefined, undefined, false);
			const input = new SessionSideChatEditorInput(draft.untitledSessionId, title, { draft });
			await editor.openEditor(input, { pinned: true });
		}
	}));
	disposables.add(MenusRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
		// Keep this entry disabled until a simulator host can open and own its view.
		command: {
			id: 'ash.sessions.openIOSSimulator',
			title: localize2({ bundle: 'ash', key: 'sessions.layout.iosSimulator' }, 'iOS Simulator'),
			icon: Lxicon.deviceMobile,
			precondition: ContextKeyExpr.false(),
		},
		when: showSessionTools,
		group: '1_tools',
		order: 2,
	}));
	for (const [id, title, icon, precondition, order] of [
		[
			'ash.sessions.back',
			localize2({ bundle: 'ash', key: 'sessions.navigation.back' }, 'Back'),
			Lxicon.chevronLeft,
			CanGoBackContext.isEqualTo(true),
			1,
		],
		[
			'ash.sessions.forward',
			localize2({ bundle: 'ash', key: 'sessions.navigation.forward' }, 'Forward'),
			Lxicon.chevronRight,
			CanGoForwardContext.isEqualTo(true),
			2,
		],
	] as const) {
		const command = { id, title, icon, precondition };
		disposables.add(
			MenusRegistry.appendMenuItems([
				{ id: Menus.TitleBarLeftLayout, item: { command, group: 'navigation', order } },
				{ id: MenuId.MenubarGoMenu, item: { command, group: 'navigation', order } },
			]),
		);
	}

	return disposables;
}

const editorVisibleContext = new RawContextKey<boolean>('sessions.editorContentVisible', false);
const detailsVisibleContext = new RawContextKey<boolean>('sessions.detailsVisible', false);
const filesVisibleContext = new RawContextKey<boolean>('sessions.filesVisible', false);
const changesVisibleContext = new RawContextKey<boolean>('sessions.changesVisible', false);
const supportedDetailsContext = new RawContextKey<boolean>('sessions.supportedDetails', false);
const filesTool = SessionsEditorToolContext.isEqualTo('files');

/** Binds the desktop entry's editor commands to its layout state and navigation queue. */
export function registerDesktopEditorLayoutActions(
	controller: DesktopLayoutController,
	context: IDesktopLayoutContext,
	contextKeys: IContextKeyService,
	layout: IAgentWorkbenchLayoutService,
	editor: EditorParts,
): IDisposable {
	const disposables = new DisposableStore();
	const editorVisible = editorVisibleContext.bindTo(contextKeys);
	const detailsVisible = detailsVisibleContext.bindTo(contextKeys);
	const fileEditorsVisible = filesVisibleContext.bindTo(contextKeys);
	const changesVisible = changesVisibleContext.bindTo(contextKeys);
	const supportedDetails = supportedDetailsContext.bindTo(contextKeys);
	const updateContext = (): void =>
		contextKeys.bufferChangeEvents(() => {
			editorVisible.set(context.isDocumentContent && layout.isPartVisible('editor') &&
				(!editor.filesDetailsVisible || editor.filesPart.isEditorVisible));
			detailsVisible.set(context.isDocumentContent && layout.isPartVisible('editor') && editor.filesDetailsVisible);
			fileEditorsVisible.set(context.isDocumentContent && layout.isPartVisible('editor') && editor.fileEditorsVisible);
			changesVisible.set(context.isDocumentContent && layout.isPartVisible('editor') && editor.groups.some(group =>
				editor.isGroupVisible(group.id) && group.activeInput?.resource.scheme === 'ash-session-changes'));
			supportedDetails.set(context.isDocumentContent && controller.supportsDetails);
		});
	disposables.add(
		toDisposable(() => {
			for (const key of [editorVisible, detailsVisible, fileEditorsVisible, changesVisible, supportedDetails]) {
				key.reset();
			}
		}),
	);
	disposables.add(layout.onDidLayoutMainContainer(updateContext));
	disposables.add(editor.onDidChangeEditors(updateContext));
	disposables.add(editor.filesPart.onDidChangeDetailsVisibility(updateContext));
	disposables.add(
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
	const hideToolId = 'ash.sessions.hideTool';
	const chatTools = ChatConversationPageContext.isEqualTo(true);
	const codeWhen = SessionsCodeEditorContext.isEqualTo(true);
	const multipleTools = EditorHasMultipleToolsContext.isEqualTo(true);
	const hideToolWhen = ContextKeyExpr.and(ContextKeyExpr.or(codeWhen, chatTools), multipleTools);
	disposables.add(CommandsRegistry.register(hideToolId, (_accessor, arg) => {
		const code = context.isDocumentContent;
		if (!code && !contextKeys.contextMatchesRules(hideToolWhen)) return;
		const groupId = isRecord(arg) && typeof arg.groupId === 'number' ? arg.groupId : editor.activeGroup.id;
		return context.runOperation(async () => {
			if (context.isDocumentContent !== code || !layout.isPartVisible('editor')) return;
			if (!editor.mainWindowGroups.some(group => group.id === groupId) || !editor.isGroupVisible(groupId)) return;
			if (code) {
				if (groupId === editor.pageGroupId || context.isConversationEditorGroup(groupId)) return;
			} else if (!contextKeys.contextMatchesRules(hideToolWhen) || !context.isActiveConversationEditorGroup(groupId)) {
				return;
			}
			editor.hideTool(groupId);
			if (editor.mainWindowGroups.every(group => !editor.isGroupVisible(group.id))) layout.hidePart('editor');
			updateContext();
		});
	}));
	disposables.add(CommandsRegistry.register('ash.sessions.maximizeTool', (_accessor, arg) => run(async () => {
		const group = isRecord(arg) ? editor.groups.find(group => group.id === arg.groupId) : undefined;
		editor.toggleMaximizeTool((group ?? editor.activeGroup).id);
	})));
	for (const [id, operation] of [
		['ash.sessions.toggleDetails', () => controller.toggleDetails()],
		['ash.sessions.toggleFiles', () => controller.toggleFiles()],
		['ash.sessions.toggleChanges', () => controller.toggleChanges()],
		[
			'ash.sessions.closeDetails',
			async () => {
				if (editor.filesDetailsOpen) { await controller.toggleDetails(); }
			},
		],
		['ash.sessions.hideEditor', () => controller.hideEditor()],
		['ash.sessions.showEditor', () => controller.showEditor()],
	] as const) {
		disposables.add(CommandsRegistry.register(id, () => run(operation)));
	}
	disposables.add(
		registerAddTabActions(
			() => run(() => controller.openFiles()),
			() => run(() => controller.openChanges()),
			codeWhen,
		),
	);
	const editorShown = ContextKeyExpr.and(codeWhen, editorVisibleContext.isEqualTo(true));
	const editorHidden = ContextKeyExpr.and(codeWhen, editorVisibleContext.isEqualTo(false));
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
	disposables.add(
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
					when: hideToolWhen,
					group: 'navigation',
					order: 3,
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
				id: Menus.SessionsEditorTitle,
				item: {
					command: { ...toggleDetails, icon: Lxicon.listUnordered },
					when: ContextKeyExpr.and(codeWhen, filesTool),
					group: '9_layout',
					order: 90,
				},
			},
			{
				id: Menus.SessionsEditorTitle,
				item: {
					command: { ...hideEditor, icon: Lxicon.layoutSidebarRightOff },
					when: ContextKeyExpr.and(editorShown, filesTool),
					group: '9_layout',
					order: 91,
				},
			},
			{
				id: Menus.SessionsEditorTitle,
				item: {
					command: { ...showEditor, icon: Lxicon.layoutSidebarRight },
					when: ContextKeyExpr.and(editorHidden, filesTool),
					group: '9_layout',
					order: 91,
				},
			},
		]),
	);
	const codeLayoutCommands = [
		{ command: toggleDetails, when: codeWhen, order: 1 },
		{ command: hideEditor, when: editorShown, order: 2 },
		{ command: showEditor, when: editorHidden, order: 2 },
	];
	disposables.add(
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
	return disposables;
}
