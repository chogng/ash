import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../../base/common/types.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IAgentSessionActionsService, getAgentSessionId } from './agentSessionsService.js';
import {
	ChatSessionArchiveActionWording,
	ChatSessionArchiveActionWordingSettingId,
	getChatSessionArchiveActionPresentation,
	getChatSessionArchiveActionWording,
	getChatSessionArchivedSectionLabel,
} from '../../../../../platform/chat/common/sessionArchiveActions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IWorkbenchLayoutService, isHorizontal } from '../../../../services/layout/browser/layoutService.js';
import { CHAT_VIEW_ID, TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID } from '../../common/chat.js';
import { ChatConfiguration } from '../../common/constants.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import type { IChatViewPane } from '../chat.js';
import { AgentSessionsViewerOrientation } from './agentSessions.js';

export function registerAgentSessionsLayoutActions(): void {
	registerAction2(FocusAgentSessionsAction);
	for (const [orientation, id, title] of [
		['stacked', 'agentSessions.hideAgentSessionsSidebar', localize2('chat.sessions.orientation.stackCommand', 'Stack Agent Sessions Above Chat')],
		['sideBySide', 'agentSessions.showAgentSessionsSidebar', localize2('chat.sessions.orientation.sidebarCommand', 'Show Agent Sessions Sidebar')],
	] as const) {
		registerAction2(class extends Action2 {
			constructor() {
				super({ id, title, precondition: ChatContextKeys.enabled.isEqualTo(true), f1: true });
			}
			override async run(accessor: ServicesAccessor): Promise<void> {
				const configuration = accessor.get(IConfigurationService);
				const resize = prepareChatResize(accessor);
				const view = await accessor.get(IViewsService).openView<IChatViewPane>(CHAT_VIEW_ID, false);
				if (!view) {
					return;
				}
				const target = orientation === 'sideBySide' ? AgentSessionsViewerOrientation.SideBySide : AgentSessionsViewerOrientation.Stacked;
				const previousDimensions = view.getLastDimensions(target);
				await configuration.updateValue(ChatConfiguration.ChatViewSessionsOrientation, orientation, ConfigurationTarget.USER_LOCAL);
				if (target === AgentSessionsViewerOrientation.SideBySide && view.getSessionsViewerOrientation() !== target) {
					view.toggleSessionsSidebar();
				}
				resize(view, target, previousDimensions?.width);
			}
		});
	}


	registerAction2(class ToggleAgentSessionsSidebarAction extends Action2 {
		constructor() {
			super({
				id: TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID,
				title: localize2('chat.sessions.showSidebar', 'Show Agent Sessions'),
				tooltip: localize('chat.sessions.showSidebar', 'Show Agent Sessions'),
				icon: Lxicon.layoutSidebarRightOff,
				toggled: {
					condition: ChatContextKeys.agentSessionsViewerOrientation.isEqualTo(AgentSessionsViewerOrientation.SideBySide),
					title: localize('chat.sessions.hideSidebar', 'Hide Agent Sessions'),
					tooltip: localize('chat.sessions.hideSidebar', 'Hide Agent Sessions'),
					icon: Lxicon.layoutSidebarRight,
				},
				menu: [
					{
						id: MenuId.ChatTitleLayout,
						group: 'navigation',
						order: 1,
					},
				],
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			const resize = prepareChatResize(accessor);
			const view = await accessor.get(IViewsService).openView<IChatViewPane>(CHAT_VIEW_ID, false);
			if (!view) {
				return;
			}
			const target = view.getSessionsViewerOrientation() === AgentSessionsViewerOrientation.SideBySide
				? AgentSessionsViewerOrientation.Stacked : AgentSessionsViewerOrientation.SideBySide;
			// Capture the target's last geometry before visibility or configuration can relayout it.
			const previousDimensions = view.getLastDimensions(target);
			if (target === AgentSessionsViewerOrientation.SideBySide) {
				await configuration.updateValue(ChatConfiguration.ChatViewSessionsOrientation, 'sideBySide', ConfigurationTarget.USER_LOCAL);
			}
			// Reveal and resize together so a settings write cannot expose the stacked layout.
			view.toggleSessionsSidebar({ visible: target === AgentSessionsViewerOrientation.SideBySide });
			resize(view, target, previousDimensions?.width);
		}
	});

}

export class FocusAgentSessionsAction extends Action2 {
	public static readonly id = 'workbench.action.chat.focusAgentSessionsViewer';

	constructor() {
		super({
			id: FocusAgentSessionsAction.id,
			title: localize2('chat.focusAgentSessionsViewer.label', 'Focus Agent Sessions'),
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const view = await accessor.get(IViewsService).openView<IChatViewPane>(CHAT_VIEW_ID, true);
		if (!view || view.focusSessions()) {
			return;
		}
		view.toggleSessionsSidebar({ visible: true });
		view.focusSessions();
	}
}

/** Capture invocation-scoped services before opening the view or saving configuration. */
function prepareChatResize(accessor: ServicesAccessor): (view: IChatViewPane, orientation: AgentSessionsViewerOrientation, previousContentWidth: number | undefined) => void {
	const contextKeys = accessor.get(IContextKeyService);
	const descriptors = accessor.get(IViewDescriptorService);
	const layout = accessor.get(IWorkbenchLayoutService);
	const paneComposites = accessor.get(IPaneCompositePartService);
	return (view, orientation, previousContentWidth): void => {
		if (contextKeys.getValue<boolean>('chatInEditor')) {
			return;
		}
		const container = descriptors.getViewContainerForView(CHAT_VIEW_ID);
		const location = container ? descriptors.getViewContainerLocation(container) : null;
		if (location === null) {
			return;
		}
		// A horizontal Panel shares its width with the editor and cannot be widened independently.
		if (location === ViewContainerLocation.Panel && isHorizontal(layout.getPanelPosition())) {
			return;
		}
		const part = paneComposites.getPartId(location);
		let size = layout.getPartSize(part);
		const paneWidth = view.element.getBoundingClientRect().width;
		const frameWidth = paneWidth > 0 ? Math.max(0, size.width - paneWidth) : 0;
		// The view owns its preferred content width; the Part adds its frame insets.
		const sideBySide = orientation === AgentSessionsViewerOrientation.SideBySide;
		const minimumWidth = view.getOptimalWidth() + frameWidth + 1;
		if (sideBySide && size.width >= minimumWidth) {
			return;
		}
		// Maximization belongs to the Workbench; closing the inner sidebar keeps that state.
		if (!sideBySide && part === 'auxiliarybar' && layout.isAuxiliaryBarMaximized()) {
			return;
		}
		if (part === 'auxiliarybar' && layout.isAuxiliaryBarMaximized()) {
			layout.setAuxiliaryBarMaximized(false);
			size = layout.getPartSize(part);
		}
		const previousWidth = previousContentWidth === undefined ? undefined : previousContentWidth + frameWidth;
		const width = sideBySide
			? Math.max(minimumWidth, previousWidth ?? layout.mainContainerDimension.width / 2)
			: previousWidth ?? Math.max(view.getOptimalWidth() + frameWidth, size.width - view.getOptimalWidth());
		layout.resizePart(part, new Dimension(width, size.height));
		if (sideBySide && part === 'auxiliarybar' && layout.getPartSize(part).width < minimumWidth) {
			layout.setAuxiliaryBarMaximized(true);
		}
	};
}

/** Shared command and prompt ownership for the IDE and Agents hosts. */
export function registerAgentSessionActions(): void {
	const archiveId = 'agentSession.archive';
	const restoreId = 'agentSession.restore';
	const archiveAllId = 'workbench.action.chat.archiveAllAgentSessions';
	registerAction2(class PinAgentSessionAction extends Action2 {
		constructor() { super({ id: 'sessions.list.togglePin', title: localize2('sessions.list.pin', 'Pin') }); }
		override run(accessor: ServicesAccessor, argument?: unknown): Promise<string> {
			return accessor.get(IAgentSessionActionsService).togglePin(argument);
		}
	});
	registerAction2(class ArchiveAgentSessionAction extends Action2 {
		constructor() { super({ id: archiveId, title: localize2('chatSession.archive', 'Archive') }); }

		override async run(accessor: ServicesAccessor, argument?: unknown): Promise<boolean> {
			const sessions = accessor.get(IAgentSessionActionsService);
			const configuration = accessor.get(IConfigurationService);
			const dialogs = accessor.get(IDialogService);
			let target: { readonly title: string; archive(): Promise<boolean>; };
			let detail: string | undefined;
			if (isRecord(argument) && 'catalogId' in argument) {
				if (Object.keys(argument).length !== 1 || typeof argument.catalogId !== 'string' || !argument.catalogId) {
					throw new TypeError(localize('chatSession.target.invalid', 'Choose a valid session.'));
				}
				target = sessions.resolveCatalogArchiveTarget(argument.catalogId);
			} else {
				await sessions.initialize();
				const session = sessions.resolveTarget(argument, true);
				target = {
					title: session.title,
					archive: async () => {
						await sessions.archiveSession((await session.resolve()).sessionId);
						return true;
					},
				};
				detail = localize('chatSession.archive.detail', 'Running work in this session will be interrupted. You can restore its root conversation later.');
			}
			const action = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(configuration)).archive;
			const result = await dialogs.confirm({
				message: localize('chatSession.archive.confirm', '{0}: {1}?', action.title.value, target.title),
				detail,
				primaryButton: action.title.value,
			});
			return result.confirmed && await target.archive();
		}
	});

	registerAction2(class ArchiveAllAgentSessionsAction extends Action2 {
		constructor() { super({ id: archiveAllId, title: localize2('chatSession.archiveAll', 'Archive All') }); }

		override async run(accessor: ServicesAccessor): Promise<void> {
			const sessions = accessor.get(IAgentSessionActionsService);
			const configuration = accessor.get(IConfigurationService);
			const dialogs = accessor.get(IDialogService);
			await sessions.initialize();
			const targets = sessions.sessions.filter(session => session.status === 'active').map(session => session.sessionId);
			if (!targets.length) throw new Error(localize('chatSession.active.none', 'No active sessions are available.'));
			const action = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(configuration)).archiveAll;
			const result = await dialogs.confirm({
				message: localize('chatSession.archiveAll.confirm', '{0} ({1} sessions)?', action.title.value, targets.length),
				detail: localize('chatSession.archiveAll.detail', 'Running work in these sessions will be interrupted. Unsent drafts are kept.'),
				primaryButton: action.title.value,
			});
			if (result.confirmed) {
				for (const id of targets) await sessions.archiveSession(id);
			}
		}
	});

	type ArchivedSessionPick = IQuickPickItem & ({ readonly sessionId: string; } | { readonly all: true; });

	registerAction2(class RestoreAgentSessionAction extends Action2 {
		constructor() { super({ id: restoreId, title: localize2('chatSession.restore', 'Restore') }); }

		override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
			getAgentSessionId(argument);
			const sessions = accessor.get(IAgentSessionActionsService);
			const navigation = accessor.get(IChatSessionNavigationService);
			const configuration = accessor.get(IConfigurationService);
			const quickInput = accessor.get(IQuickInputService);
			await sessions.initialize();
			const restore = async (id: string, shouldOpen = () => true) => {
				await sessions.restoreSession(id);
				if (!shouldOpen()) return;
				const root = sessions.sessions.find(session => session.sessionId === id)?.rootThreadId;
				if (!root) throw new Error(localize('chatSession.restore.rootMissing', 'The restored root conversation is unavailable.'));
				await navigation.openConversation(id, root);
			};
			if (typeof argument === 'string') { await restore(argument); return; }
			const archived = sessions.sessions.filter(session => session.status === 'archived');
			if (!archived.length) throw new Error(localize('chatSession.archived.none', 'No archived sessions are available.'));
			const wording = getChatSessionArchiveActionWording(configuration);
			const presentation = getChatSessionArchiveActionPresentation(wording);
			const resources = new DisposableStore();
			const picker = resources.add(quickInput.createQuickPick<ArchivedSessionPick>());
			picker.ariaLabel = localize('chatSession.restore.picker', '{0} — {1}', presentation.unarchive.title.value, getChatSessionArchivedSectionLabel(wording));
			picker.placeholder = picker.ariaLabel;
			picker.items = [
				{ label: presentation.unarchiveAll.title.value, all: true },
				{ type: 'separator', label: getChatSessionArchivedSectionLabel(wording) },
				...archived.map(session => ({ label: session.title, sessionId: session.sessionId, description: session.description })),
			];
			try {
				await new Promise<void>((resolve, reject) => {
					let pending = false;
					let closed = false;
					resources.add(picker.onDidHide(() => { closed = true; if (!pending) resolve(); }));
					resources.add(picker.onDidAccept(async () => {
						const item = picker.selectedItems[0];
						if (!item || pending) return;
						pending = true;
						picker.busy = true;
						try {
							if ('all' in item) {
								// Bulk restoration updates the catalog without taking focus from a draft.
								for (const session of archived) await sessions.restoreSession(session.sessionId);
							} else await restore(item.sessionId, () => !closed);
							resolve();
						} catch (error) { reject(error); }
						finally { picker.hide(); }
					}));
					picker.show();
				});
			} finally { resources.dispose(); }
		}
	});

	// The command IDs stay stable while each window resolves its configured wording.
	for (const wording of [ChatSessionArchiveActionWording.Archive, ChatSessionArchiveActionWording.MarkAsDone]) {
		const presentation = getChatSessionArchiveActionPresentation(wording);
		const done = ContextKeyExpr.equals(`config.${ChatSessionArchiveActionWordingSettingId}`, 'done');
		const when = wording === ChatSessionArchiveActionWording.MarkAsDone ? done : ContextKeyExpr.notEquals(`config.${ChatSessionArchiveActionWordingSettingId}`, 'done');
		for (const [id, action] of [[archiveId, presentation.archive], [restoreId, presentation.unarchive], [archiveAllId, presentation.archiveAll]] as const) {
			MenusRegistry.appendMenuItem(MenuId.CommandPalette, { command: { id, title: localize2('chatSession.paletteAction', 'Chat: {0}', action.title.value), icon: action.icon }, when });
		}
	}


	registerAction2(class RenameAgentSessionAction extends Action2 {
		constructor() { super({ id: 'agentSession.rename', title: localize2('chatSession.rename', 'Chat: Rename Session'), f1: true }); }

		override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
			const sessions = accessor.get(IAgentSessionActionsService);
			await sessions.initialize();
			const target = sessions.resolveTarget(argument, true);
			const title = await accessor.get(IQuickInputService).input({
				title: localize('chatSession.rename.prompt', 'Session name'), value: target.title,
				validateInput: async value => !value.trim() || Array.from(value.trim()).length > 256 ? localize('chat.rename.invalid', 'Enter a name with 1 to 256 characters.') : undefined,
			});
			if (title !== undefined) await sessions.renameSession((await target.resolve()).sessionId, title.trim());
		}
	});

	registerAction2(class DeleteAgentSessionAction extends Action2 {
		constructor() { super({ id: 'agentSession.delete', title: localize2('chatSession.delete', 'Chat: Delete Archived Session'), f1: true }); }

		override async run(accessor: ServicesAccessor, argument?: unknown): Promise<void> {
			const sessions = accessor.get(IAgentSessionActionsService);
			if (sessions.discardDraft(argument)) return;
			const dialogs = accessor.get(IDialogService);
			if (isRecord(argument) && 'catalogId' in argument) {
				const { catalogId, preferenceKey } = argument;
				if (typeof catalogId !== 'string' || !catalogId || (preferenceKey !== undefined && typeof preferenceKey !== 'string')
					|| Object.keys(argument).some(key => key !== 'catalogId' && key !== 'preferenceKey')) {
					throw new TypeError(localize('chatSession.target.invalid', 'Choose a valid session.'));
				}
				const target = sessions.resolveCatalogDeleteTarget(catalogId, preferenceKey);
				await confirmSessionDeletion(dialogs, target.title,
					localize('chatSession.delete.conversationDetail', 'This conversation and its history will be permanently deleted.'), target.remove);
				return;
			}
			const requested = getAgentSessionId(argument);
			const input = accessor.get(IQuickInputService);
			await sessions.initialize();
			const archived = sessions.sessions.filter(session => session.status === 'archived');
			let id = requested;
			if (!id) {
				if (!archived.length) throw new Error(localize('chatSession.archived.none', 'No archived sessions are available.'));
				using resources = new DisposableStore();
				const picker = resources.add(input.createQuickPick<IQuickPickItem & { sessionId: string; }>());
				picker.ariaLabel = picker.placeholder = localize('chatSession.delete.pick', 'Choose an archived session to delete');
				picker.items = archived.map(session => ({ label: session.title, sessionId: session.sessionId }));
				id = await new Promise<string | undefined>(resolve => {
					resources.add(picker.onDidAccept(() => { const item = picker.selectedItems[0]; if (item) { resolve(item.sessionId); picker.hide(); } }));
					resources.add(picker.onDidHide(() => resolve(undefined)));
					picker.show();
				});
			}
			if (!id) return;
			const session = sessions.sessions.find(candidate => candidate.sessionId === id);
			if (!session) throw new Error(localize('chatSession.archived.missing', 'Archived session is unavailable: {0}', id));
			await confirmSessionDeletion(dialogs, session.title,
				localize('chatSession.delete.detail', 'This removes the session and its conversation history and cannot be undone. Any resumed work in this session will be stopped. Other sessions and unsent drafts are kept.'),
				async () => {
					if (session.status === 'active') await sessions.archiveSession(session.sessionId);
					await sessions.deleteSession(session.sessionId);
				});
		}
	});
}

async function confirmSessionDeletion(dialogs: IDialogService, title: string, detail: string, remove: () => Promise<void>): Promise<void> {
	const confirmation = await dialogs.confirm({
		message: localize('chatSession.delete.confirm', 'Permanently delete {0}?', title),
		detail,
		primaryButton: localize('chatSession.delete.button', 'Delete permanently'),
		destructive: true,
	});
	if (confirmation.confirmed) await remove();
}
