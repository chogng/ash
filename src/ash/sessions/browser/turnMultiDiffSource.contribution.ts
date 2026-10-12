import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { OPEN_CHAT_CHANGES_COMMAND_ID } from '../../workbench/contrib/chat/common/chat.js';
import { localize } from '../../nls.js';
import { IChatService } from '../../workbench/services/chat/common/chatService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { createTurnMultiDiffEditorInput } from './turnMultiDiffSource.js';

CommandsRegistry.register(OPEN_CHAT_CHANGES_COMMAND_ID, async (accessor, sessionId, threadId) => {
	if (typeof sessionId !== 'string' || !sessionId || typeof threadId !== 'string' || !threadId) {
		throw new Error(localize('chat.changes.invalidIdentity', 'Changes require a conversation.'));
	}
	const sessions = accessor.get(ISessionsManagementService);
	const session = sessions.sessions.find(candidate => candidate.sessionId === sessionId);
	if (!session || !session.chats.some(chat => chat.threadId === threadId)) {
		throw new Error(localize('chat.changes.unavailable', 'This conversation is no longer available.'));
	}
	// Sessions reveals its managed Changes tab; the Workbench opens the identity-bound comparison below.
	if (CommandsRegistry.hasCommand('workbench.agentSessions.action.viewChanges') && sessions.active?.session.sessionId === sessionId && sessions.active.threadId === threadId) {
		const opened = await accessor.get(ICommandService).executeCommand('workbench.agentSessions.action.viewChanges');
		if (opened !== false) return;
	}
	const input = await createTurnMultiDiffEditorInput(accessor.get(IChatService), { session, threadId }, 'throughCurrentTurn');
	await accessor.get(IEditorService).openEditor({ ...input, label: localize('chat.changes.title', 'Changes') }, { pinned: true });
});
