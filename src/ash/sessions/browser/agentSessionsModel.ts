import './media/sessionItemActions.css';
import { type ISessionsListModelService } from '../services/sessions/browser/sessionsListModelService.js';
import { Separator, type IAction } from '../../base/common/actions.js';
import { Lxicon } from '../../base/common/lxicons.js';
import type { ICommandService } from '../../platform/commands/common/commands.js';
import type { INotificationService } from '../../platform/notification/common/notification.js';
import type { SessionsViewSelection } from '../services/sessions/browser/sessionsService.js';
import { localize } from '../../nls.js';

/** Session menus share presentation and captured-target commands; opening a window is host-owned. */
export function createSessionItemActions(selection: SessionsViewSelection, commands: ICommandService, listModel: ISessionsListModelService, notifications: INotificationService, openInNewWindow: () => Promise<unknown>, didPin?: (sessionId: string) => void): readonly IAction[] {
	const id = selection.kind === 'session' ? selection.active.session.sessionId : undefined;
	const target = selection.kind === 'untitled' ? { untitledSessionId: selection.session.untitledSessionId } : id;
	const pinned = selection.kind === 'session' && listModel.isSessionPinned(selection.active.session);
	const action = (commandId: string, label: string, icon: NonNullable<IAction['icon']>, argument: unknown = target): IAction => ({
		id: commandId, label, icon, enabled: true, tooltip: '',
		run: () => commands.executeCommand(commandId, argument).catch(error => notifications.error(String(error))),
	});
	return [
		{
			...action('sessions.list.togglePin', pinned ? localize('sessions.list.unpin', 'Unpin') : localize('sessions.list.pin', 'Pin'), pinned ? Lxicon.unpin : Lxicon.pin),
			run: async () => {
				try { const id = await commands.executeCommand<string>('sessions.list.togglePin', target); didPin?.(id); }
				catch (error) { notifications.error(String(error)); }
			}
		},
		action('agentSession.rename', localize('sessions.list.rename', 'Rename'), Lxicon.edit),
		new Separator(),
		action('agentSession.addToProject', localize('sessions.list.addToProject', 'Add to project'), Lxicon.newFolder),
		action('agentSession.moveToGroup', localize('sessions.list.moveToGroup', 'Move to group'), Lxicon.folders),
		new Separator(),
		{
			...action('sessions.openInNewWindow', localize('sessions.list.openWindow', 'Open in new window'), Lxicon.linkExternal),
			run: () => openInNewWindow().catch(error => notifications.error(String(error)))
		},
		new Separator(),
		action('agentSession.archive', localize('chatSession.archive', 'Archive'), Lxicon.archive),
		{
			...action('agentSession.delete', localize('sessions.list.delete', 'Delete'), Lxicon.trash, id ?? selection),
			class: 'ash-session-delete-action',
		},
	];
}
