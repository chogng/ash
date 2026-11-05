import { NEW_SESSION_ACTION_ID } from '../common/constants.js';
import { localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { IUntitledChatSession } from '../../../services/sessions/common/session.js';

// Shared Chat actions reach this window's creation policy through its navigation service.
export class NewChatInSessionsWindowAction extends Action2 {
	constructor() {
		super({ id: NEW_SESSION_ACTION_ID, title: localize2({ bundle: 'ash', key: 'chat.sessions.new' }, 'New Session') });
	}

	override async run(accessor: ServicesAccessor, providerId?: string): Promise<IUntitledChatSession> {
		if (providerId !== undefined && (typeof providerId !== 'string' || !providerId.trim())) {
			throw new TypeError('Expected a Sessions provider ID');
		}
		return accessor.get(ISessionsService).openNewSession(undefined, { providerId });
	}
}

export class NewSessionFromNavigationAction extends Action2 {
	constructor() {
		super({ id: 'sessions.newSession', title: localize2('sessions.activity.new', 'New') });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commands = accessor.get(ICommandService);
		const contextKeys = accessor.get(IContextKeyService);
		const mode = contextKeys.getValue(SessionsWorkspaceModeContext.key);
		const entryCommand = accessor.get(ISessionsLayoutService).newSessionCommand;
		if (entryCommand) {
			await commands.executeCommand(entryCommand);
			return;
		}
		if (mode !== 'code' && CommandsRegistry.hasCommand('sessions.open.new')) {
			await commands.executeCommand('sessions.open.new');
			return;
		}
		const layout = accessor.get(ILayoutService);
		let created: IUntitledChatSession | undefined;
		if (mode === 'code') {
			const sessions = accessor.get(ISessionsService);
			const revision = sessions.navigationRevision;
			let pageChanged = false;
			using pageListener = contextKeys.onDidChangeContext(event => {
				for (const key of event.keys) {
					if (key.startsWith('sessions.activity.') && key.endsWith('Selected')) pageChanged = true;
				}
			});
			const target = await accessor.get(ISessionsManagementService).resolveNewSessionTarget();
			if (pageChanged || revision !== sessions.navigationRevision || contextKeys.getValue(SessionsWorkspaceModeContext.key) !== mode) return;
			created = sessions.openNewSession(undefined, target);
		} else {
			created = await commands.executeCommand<IUntitledChatSession | undefined>(NEW_SESSION_ACTION_ID);
		}
		if (created) {
			await commands.executeCommand(mode === 'code' ? 'sessions.open.code' : 'sessions.open.chat');
			layout.focus();
		}
	}
}
