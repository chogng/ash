import { Separator, type IAction } from '../../base/common/actions.js';
import type { ICommandService } from '../../platform/commands/common/commands.js';
import type { INotificationService } from '../../platform/notification/common/notification.js';
import { StorageScope, type IStorageService } from '../../platform/storage/common/storage.js';
import type { SessionsViewSelection } from '../services/sessions/browser/sessionsService.js';
import { localize } from '../../nls.js';

/** Both list hosts invoke the same captured-target commands; only their window owner differs. */
export function createSessionItemActions(selection: SessionsViewSelection, commands: ICommandService, storage: IStorageService, notifications: INotificationService, openInNewWindow: () => Promise<unknown>, didPin?: (sessionId: string) => void): readonly IAction[] {
	const id = selection.kind === 'session' ? selection.active.session.sessionId : undefined;
	const target = selection.kind === 'untitled' ? { untitledSessionId: selection.session.untitledSessionId } : id;
	const pinned = id !== undefined && storage.getBoolean(`sessions.list.pinned.${id}`, StorageScope.PROFILE, false);
	const action = (commandId: string, label: string, argument: unknown = target): IAction => ({
		id: commandId, label, enabled: true, tooltip: '',
		run: () => commands.executeCommand(commandId, argument).catch(error => notifications.error(String(error))),
	});
	return [
		{
			...action('sessions.list.togglePin', pinned ? localize('sessions.list.unpin', 'Unpin chat') : localize('sessions.list.pin', 'Pin chat')),
			run: async () => {
				try { const id = await commands.executeCommand<string>('sessions.list.togglePin', target); didPin?.(id); }
				catch (error) { notifications.error(String(error)); }
			}
		},
		action('agentSession.rename', localize('sessions.list.rename', 'Rename')),
		action('agentSession.archive', localize('chatSession.archive', 'Archive')),
		new Separator(),
		action('agentSession.addToProject', localize('sessions.list.addToProject', 'Add to project')),
		action('agentSession.moveToGroup', localize('sessions.list.moveToGroup', 'Move to group')),
		new Separator(),
		action('agentSession.delete', localize('sessions.list.delete', 'Delete'), id ?? selection),
		new Separator(),
		{
			...action('sessions.openInNewWindow', localize('sessions.list.openWindow', 'Open in new window')),
			run: () => openInNewWindow().catch(error => notifications.error(String(error)))
		},
	];
}
