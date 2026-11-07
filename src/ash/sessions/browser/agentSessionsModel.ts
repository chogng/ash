import './media/sessionItemActions.css';
import { type ISessionsListModelService } from '../services/sessions/browser/sessionsListModelService.js';
import { Separator, type IAction } from '../../base/common/actions.js';
import { Lxicon } from '../../base/common/lxicons.js';
import type { ICommandService } from '../../platform/commands/common/commands.js';
import type { INotificationService } from '../../platform/notification/common/notification.js';
import type { SessionsViewSelection } from '../services/sessions/browser/sessionsService.js';
import type { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { localize } from '../../nls.js';
import { MenusRegistry, type MenuId } from '../../platform/actions/common/actions.js';
import { Menus } from './menus.js';
import { SessionsMenuActiveConversationContext, SessionsMenuConversationPinnedContext } from '../common/contextkeys.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';

const rename = () => ({ id: 'agentSession.rename', title: localize('sessions.list.rename', 'Rename'), icon: Lxicon.edit });
const moveToGroup = () => ({ id: 'agentSession.moveToGroup', title: localize('sessions.list.moveToGroup', 'Move to group'), icon: Lxicon.folders });
const addToProject = () => ({ id: 'agentSession.addToProject', title: localize('sessions.list.addToProject', 'Add to project'), icon: Lxicon.newFolder });
const archive = () => ({ id: 'agentSession.archive', title: localize('chatSession.archive', 'Archive'), icon: Lxicon.archive });
const remove = () => ({ id: 'agentSession.delete', title: localize('sessions.list.delete', 'Delete'), icon: Lxicon.trash });
const pin = () => ({ id: 'sessions.list.togglePin', title: localize('sessions.list.pin', 'Pin'), icon: Lxicon.pin });
const unpin = () => ({ title: localize('sessions.list.unpin', 'Unpin'), icon: Lxicon.unpin });

function registerSidebarSessionActions(menuId: MenuId): void {
	const when = SessionsMenuActiveConversationContext.isEqualTo(true);
	MenusRegistry.appendMenuItems([
		{ id: menuId, item: { when: ContextKeyExpr.and(when, SessionsMenuConversationPinnedContext.isEqualTo(false)), group: '1_edit', order: 1, command: pin() } },
		{ id: menuId, item: { when: ContextKeyExpr.and(when, SessionsMenuConversationPinnedContext.isEqualTo(true)), group: '1_edit', order: 1, command: { ...pin(), ...unpin() } } },
		{ id: menuId, item: { when, group: '1_edit', order: 2, command: rename() } },
		{ id: menuId, item: { when, group: '2_organize', order: 1, command: addToProject() } },
		{ id: menuId, item: { when, group: '2_organize', order: 2, command: moveToGroup() } },
		{ id: menuId, item: { when, group: '3_remove', order: 1, command: archive() } },
		{ id: menuId, item: { when, group: '3_remove', order: 2, command: remove() } },
	]);
}

registerSidebarSessionActions(Menus.SidebarChatSessionContext);
registerSidebarSessionActions(Menus.SidebarCodeSessionContext);

export function getSessionWorkspaceMenuState(sessionId: string, threadId: string, sessions: ISessionsManagementService) {
	if (threadId !== sessionId) return undefined;
	const enabled = sessions.canChangeDirectory?.(sessionId) === true;
	if (!enabled && !sessions.canChangeDirectory?.(sessionId, { ignoreActivity: true })) return undefined;
	const workspace = sessions.sessions.find(session => session.sessionId === sessionId)?.workspace;
	return {
		enabled,
		changeLabel: workspace
			? localize({ bundle: 'ash.sessions', key: 'sessions.directory.change' }, 'Change Workspace…')
			: localize({ bundle: 'ash.sessions', key: 'sessions.directory.set' }, 'Set Workspace…'),
		clearLabel: workspace && sessions.canClearDirectory?.(sessionId)
			? localize({ bundle: 'ash.sessions', key: 'sessions.directory.clear' }, 'Remove Workspace')
			: undefined,
		busyBadge: enabled ? undefined : localize({ bundle: 'ash.sessions', key: 'sessions.directory.wait' }, 'Available when idle'),
	};
}

export function createSessionWorkspaceActions(sessionId: string, threadId: string, sessions: ISessionsManagementService, commands: ICommandService): IAction[] {
	const workspace = getSessionWorkspaceMenuState(sessionId, threadId, sessions);
	if (!workspace) return [];
	const actions: IAction[] = [{
		id: 'agentSession.changeDirectory',
		label: workspace.changeLabel,
		tooltip: '', enabled: workspace.enabled, icon: Lxicon.folder,
		badge: workspace.busyBadge,
		run: () => commands.executeCommand('agentSession.changeDirectory', sessionId),
	}];
	if (workspace.clearLabel) {
		actions.push({
			id: 'agentSession.clearDirectory',
			label: workspace.clearLabel,
			tooltip: '', enabled: workspace.enabled,
			run: () => commands.executeCommand('agentSession.clearDirectory', sessionId),
		});
	}
	return actions;
}

/** Session menus share presentation and captured-target commands; opening a window is host-owned. */
export function createSessionItemActions(selection: SessionsViewSelection, commands: ICommandService, listModel: ISessionsListModelService, notifications: INotificationService, openInNewWindow: () => Promise<unknown>, didPin?: (sessionId: string) => void): readonly IAction[] {
	const id = selection.kind === 'session' ? selection.active.session.sessionId : undefined;
	const target = selection.kind === 'untitled' ? { untitledSessionId: selection.session.untitledSessionId } : id;
	const pinned = selection.kind === 'session' && listModel.isSessionPinned(selection.active.session);
	const action = (commandId: string, label: string, icon: NonNullable<IAction['icon']>): IAction => ({
		id: commandId, label, icon, enabled: true, tooltip: '',
		run: () => commands.executeCommand(commandId, target).catch(error => notifications.error(String(error))),
	});
	const conversationAction = ({ id: commandId, title, icon }: ReturnType<typeof rename>): IAction => action(commandId, title, icon);
	const { title: pinLabel, icon: pinIcon } = pinned ? unpin() : pin();
	return [
		{
			...action('sessions.list.togglePin', pinLabel, pinIcon),
			run: async () => {
				try { const id = await commands.executeCommand<string>('sessions.list.togglePin', target); didPin?.(id); }
				catch (error) { notifications.error(String(error)); }
			}
		},
		conversationAction(rename()),
		new Separator(),
		conversationAction(addToProject()),
		conversationAction(moveToGroup()),
		new Separator(),
		{
			...action('sessions.openInNewWindow', localize('sessions.list.openWindow', 'Open in new window'), Lxicon.linkExternal),
			run: () => openInNewWindow().catch(error => notifications.error(String(error)))
		},
		new Separator(),
		conversationAction(archive()),
		{
			...conversationAction(remove()), class: 'ash-session-delete-action',
			run: () => commands.executeCommand('agentSession.delete', id ?? selection).catch(error => notifications.error(String(error))),
		},
	];
}
