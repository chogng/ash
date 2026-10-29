import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { OPEN_CHAT_CHANGES_COMMAND_ID } from '../../workbench/contrib/chat/common/chat.js';
import { localize } from '../../nls.js';
import { IChatService } from '../../workbench/services/chat/common/chatService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { createThreadMultiDiffEditorInput, ThreadChangesNotCurrentError } from './turnMultiDiffSource.js';

CommandsRegistry.register(OPEN_CHAT_CHANGES_COMMAND_ID, async (accessor, sessionId, threadId, revision) => {
	if (sessionId === undefined && threadId === undefined) {
		await accessor.get(ICommandService).executeCommand('git.openWorkspaceChanges');
		return;
	}
	if (typeof sessionId !== 'string' || !sessionId || typeof threadId !== 'string' || !threadId) {
		throw new Error(localize('chat.changes.invalidIdentity', 'Changes require a conversation.'));
	}
	const sessions = accessor.get(ISessionsManagementService);
	const session = sessions.sessions.find(candidate => candidate.sessionId === sessionId);
	if (!session || !session.chats.some(chat => chat.threadId === threadId)) {
		throw new Error(localize('chat.changes.unavailable', 'This conversation is no longer available.'));
	}
	if (revision !== undefined && typeof revision !== 'string') throw new TypeError('Invalid changes revision');
	const active = sessions.active;
	const untitled = sessions.activeUntitledSession;
	let switched = false;
	using selectionListener = sessions.onDidChange(() => {
		switched ||= sessions.active?.session.sessionId !== active?.session.sessionId || sessions.active?.threadId !== active?.threadId || sessions.activeUntitledSession !== untitled;
	});
	const chat = accessor.get(IChatService);
	const input = await createThreadMultiDiffEditorInput(chat, sessionId, threadId, revision).catch(error => {
		if (!(error instanceof ThreadChangesNotCurrentError)) throw error;
		if (switched) return undefined;
		// Capture notifications can update the counts before the final journal revision arrives.
		// Start once from the current checkpoint; changes during file loading still reject review.
		return createThreadMultiDiffEditorInput(chat, sessionId, threadId);
	});
	if (!input || switched) return;
	await accessor.get(IEditorService).openEditor(input, { pinned: true });
});
