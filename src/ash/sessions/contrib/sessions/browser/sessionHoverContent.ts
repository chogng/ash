import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import type { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { agentHostSessionWorkspaceKey } from '../../../common/agentHostSessionWorkspace.js';
import { chatExecutionWorkspace, type IChat, type ISession, type SessionId, type ThreadId } from '../../../services/sessions/common/session.js';
import type { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export function getSessionSummaryHoverData(session: ISession, chat?: IChat): readonly string[] {
	// Hydrating a thread can replace its execution directory with the managed checkout.
	const projectFolder = session.workspace?.root;
	const provider = session.providerLabel ?? session.application?.label;
	const updatedAt = chat?.updatedAt;
	const details: string[] = [];
	if (projectFolder) {
		details.push(localize('sessions.hover.workspace', 'Project folder: {0}', projectFolder));
	}
	if (provider) {
		details.push(localize('sessions.hover.provider', 'Provider: {0}', provider));
	}
	if (updatedAt && Number.isFinite(updatedAt.getTime())) {
		details.push(localize('sessions.hover.updated', 'Updated: {0}', updatedAt.toLocaleString(getNLSLanguage())));
	}
	return details;
}

/** Reads metadata only while the card is shown, on the conversation's owning host. */
export async function loadSessionSummaryHoverDetails(
	management: ISessionsManagementService,
	scopes: ISessionProviderScopeService,
	sessionId: SessionId,
	threadId: ThreadId,
	token: CancellationToken,
): Promise<readonly string[]> {
	const findSession = (): ISession | undefined => management.sessions.find(session => session.sessionId === sessionId);
	const session = findSession();
	const chat = session?.chats.find(chat => chat.threadId === threadId);
	if (!session || !chat || token.isCancellationRequested) {
		return [];
	}
	const scope = scopes.getScope(sessionId);
	scope.assertCurrent();
	const backendSessionId = scope.backendIdentity(sessionId);
	const backendThreadId = scope.backendIdentity(threadId);
	const workspace = chatExecutionWorkspace(session, chat);
	const [repositories, changes] = await Promise.allSettled([
		workspace ? scope.services.host.localGit.readRepositoryContexts({ sessionId: backendSessionId, path: workspace.root }, token) : undefined,
		scope.services.chat.readThreadChanges(backendSessionId, backendThreadId),
	]);
	if (token.isCancellationRequested) {
		return [];
	}
	scope.assertCurrent();
	const current = findSession();
	const currentChat = current?.chats.find(chat => chat.threadId === threadId);
	if (!current || !currentChat || current.providerId !== session.providerId
		|| agentHostSessionWorkspaceKey(chatExecutionWorkspace(current, currentChat)) !== agentHostSessionWorkspaceKey(workspace)) {
		return [];
	}
	const details: string[] = [];
	if (changes.status === 'fulfilled' && changes.value.worktreePath) {
		details.push(localize('sessions.hover.worktree', 'Worktree: {0}', changes.value.worktreePath));
	}
	if (repositories.status === 'fulfilled' && repositories.value?.length === 1) {
		const { head } = repositories.value[0];
		if (head.type === 'branch' && head.name) {
			details.push(localize('sessions.hover.branch', 'Branch: {0}', head.name));
		}
	}
	if (changes.status === 'fulfilled' && changes.value.statistics.files > 0) {
		const { files, additions, deletions } = changes.value.statistics;
		details.push(localize('sessions.hover.changes', 'Changed files: {0} (+{1} / −{2})', files, additions, deletions));
	}
	return details;
}
