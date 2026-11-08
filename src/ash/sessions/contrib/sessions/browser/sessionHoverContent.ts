import { h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { formatTimeAgo } from '../../../../base/common/date.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import type { ThreadChangesSummary } from '../../../../workbench/services/chat/common/chatService.js';
import type { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { agentHostSessionWorkspaceKey, buildAgentHostChatWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { chatExecutionWorkspace, type IChat, type ISession, type SessionId, type ThreadId } from '../../../services/sessions/common/session.js';
import type { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

/** Builds a fresh preview on each display, using the hover's cancellation token for Git metadata. */
export function createSessionPreviewHover(
	document: Document,
	{ title, projectName, timestamp, loadBranch }: {
		readonly title: string;
		readonly projectName?: string;
		readonly timestamp: number;
		readonly loadBranch?: (token: CancellationToken) => Promise<string | undefined>;
	},
): (token: CancellationToken) => HTMLElement {
	return token => {
		const heading = h(document, 'div', { className: 'ash-sessions-list-preview-heading' }, h(document, 'strong', title));
		if (Number.isFinite(timestamp)) {
			const formatter = new Intl.RelativeTimeFormat(getNLSLanguage(), { numeric: 'auto' });
			const label = formatTimeAgo(timestamp, Date.now(), formatter) ?? formatter.format(0, 'second');
			heading.append(' ', h(document, 'time', { attributes: { datetime: new Date(timestamp).toISOString() } }, label));
		}
		const card = h(document, 'div', { className: 'ash-sessions-list-preview' }, heading);
		if (projectName) {
			const project = h(document, 'div', { className: 'ash-sessions-list-preview-project' });
			appendIcon(Lxicon.folder, project);
			project.append(h(document, 'span', projectName));
			card.append('\n', project);
		}
		if (loadBranch) {
			void loadBranch(token).then(branch => {
				if (!branch || token.isCancellationRequested) return;
				const detail = h(document, 'div', { className: 'ash-sessions-list-preview-branch' });
				appendIcon(Lxicon.gitBranch, detail);
				detail.append(h(document, 'span', branch));
				card.append('\n', detail);
			}, () => { /* Git metadata is optional when the owning host is unavailable. */ });
		}
		return card;
	};
}

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
	const metadata = await loadSessionHoverMetadata(management, scopes, sessionId, threadId, token, true);
	if (!metadata) return [];
	const { branch, changes } = metadata;
	const details: string[] = [];
	if (changes?.worktreePath) {
		details.push(localize('sessions.hover.worktree', 'Worktree: {0}', changes.worktreePath));
	}
	if (branch) details.push(branch);
	if (changes && changes.statistics.files > 0) {
		const { files, additions, deletions } = changes.statistics;
		details.push(localize('sessions.hover.changes', 'Changed files: {0} (+{1} / −{2})', files, additions, deletions));
	}
	return details;
}

/** Loads the branch for a single preview, including unopened worktrees. */
export async function loadSessionHoverBranch(
	management: ISessionsManagementService,
	scopes: ISessionProviderScopeService,
	sessionId: SessionId,
	threadId: ThreadId,
	token: CancellationToken,
): Promise<string | undefined> {
	return (await loadSessionHoverMetadata(management, scopes, sessionId, threadId, token, false))?.branch;
}

async function loadSessionHoverMetadata(
	management: ISessionsManagementService,
	scopes: ISessionProviderScopeService,
	sessionId: SessionId,
	threadId: ThreadId,
	token: CancellationToken,
	includeChanges: boolean,
): Promise<{ branch?: string; changes?: ThreadChangesSummary; } | undefined> {
	const findSession = (): ISession | undefined => management.sessions.find(session => session.sessionId === sessionId);
	const session = findSession();
	const chat = session?.chats.find(chat => chat.threadId === threadId);
	if (!session || !chat || token.isCancellationRequested) {
		return undefined;
	}
	const scope = scopes.getScope(sessionId);
	scope.assertCurrent();
	const backendSessionId = scope.backendIdentity(sessionId);
	const catalogWorkspace = chatExecutionWorkspace(session, chat);
	let workspace = catalogWorkspace;
	if (!includeChanges && chat.workspace === undefined) {
		// Read the unopened Thread's directory without opening a transcript subscription.
		const { directory } = await raceCancellationError(scope.services.chat.readThread(backendSessionId, scope.backendIdentity(threadId), {
			type: 'latest', turnLimit: 1,
		}), token);
		scope.assertCurrent();
		workspace = buildAgentHostChatWorkspace(directory ?? null);
	}
	const [repositories, changes] = await Promise.allSettled([
		workspace ? scope.services.host.localGit.readRepositoryContexts({ sessionId: backendSessionId, path: workspace.root }, token) : undefined,
		includeChanges ? scope.services.chat.readThreadChanges(backendSessionId, scope.backendIdentity(threadId)) : undefined,
	]);
	if (token.isCancellationRequested) {
		return undefined;
	}
	scope.assertCurrent();
	const current = findSession();
	const currentChat = current?.chats.find(chat => chat.threadId === threadId);
	const expectedWorkspace = currentChat?.workspace === undefined ? catalogWorkspace : workspace;
	if (!current || !currentChat || current.providerId !== session.providerId
		|| agentHostSessionWorkspaceKey(chatExecutionWorkspace(current, currentChat)) !== agentHostSessionWorkspaceKey(expectedWorkspace)) {
		return undefined;
	}
	const head = repositories.status === 'fulfilled' && repositories.value?.length === 1 ? repositories.value[0].head : undefined;
	return {
		branch: head?.type === 'branch' && head.name ? localize('sessions.hover.branch', 'Branch: {0}', head.name) : undefined,
		changes: changes.status === 'fulfilled' ? changes.value : undefined,
	};
}
