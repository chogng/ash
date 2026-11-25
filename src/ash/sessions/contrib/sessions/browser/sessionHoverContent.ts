import { h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { formatTimeAgo } from '../../../../base/common/date.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { URI } from '../../../../base/common/uri.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import type { ThreadChangesSummary } from '../../../../platform/turnChanges/common/turnChangesApi.js';
import type { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { agentHostSessionWorkspaceKey, buildAgentHostChatWorkspace } from '../../../../workbench/contrib/sessions/common/agentHostSessionWorkspace.js';
import { chatExecutionWorkspace, type IChat, type ISession, type SessionId, type ThreadId } from '../../../../workbench/services/sessions/common/session.js';
import type { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { SessionsCatalogProject } from './views/sessionsCatalogList.js';

interface ConversationPreview {
	readonly title: string;
	readonly projectName?: string;
	readonly timestamp?: number;
}

interface PreviewSource {
	readonly key: string;
	load(token: CancellationToken): Promise<string | undefined>;
}

interface PreviewPathLabel {
	readonly label: string;
	readonly basename: string;
}

export type SessionListPreviewContent =
	| (ConversationPreview & { readonly kind: 'chatConversation'; })
	| (ConversationPreview & { readonly kind: 'codeConversation'; readonly branch?: PreviewSource; })
	| {
		readonly kind: 'project';
		readonly title: string;
		readonly details?: SessionsCatalogProject['preview'];
		readonly paths?: {
			readonly folders: readonly URI[];
			readonly formatPath: (folder: URI) => PreviewPathLabel;
		};
	};

const previewDetailIcons = {
	project: Lxicon.folder,
	path: Lxicon.folder,
	branch: Lxicon.gitBranch,
	count: Lxicon.chatSession,
};

/** Builds the preview anew on each display and cancels its metadata reads when the hover closes. */
export function createSessionPreviewHover(document: Document, preview: SessionListPreviewContent): (token: CancellationToken) => HTMLElement {
	return token => {
		const heading = h(document, 'div', { className: 'ash-sessions-list-preview-heading' }, h(document, 'strong', preview.title));
		const card = h(document, 'div', { className: 'ash-sessions-list-preview' }, heading);
		const detail = (content: string | HTMLElement, kind: keyof typeof previewDetailIcons): HTMLElement => {
			const row = h(document, 'div', { className: `ash-sessions-list-preview-${kind}` });
			appendIcon(previewDetailIcons[kind], row);
			row.append(typeof content === 'string' ? h(document, 'span', content) : content);
			return row;
		};
		const insertDetail = (element: HTMLElement, before: HTMLElement | null = null) => {
			if (before) before.before(element, '\n');
			else card.append('\n', element);
		};
		const insertLoadedDetail = (source: PreviewSource, render: (value: string) => HTMLElement, before: HTMLElement | null) => {
			void source.load(token).then(value => {
				if (value?.trim() && !token.isCancellationRequested && card.isConnected) insertDetail(render(value), before);
			}, () => { /* Metadata can be unavailable independently of the row. */ });
		};

		switch (preview.kind) {
			case 'chatConversation':
			case 'codeConversation': {
				if (preview.projectName) insertDetail(detail(preview.projectName, 'project'));
				const time = createPreviewTime(document, preview.timestamp);
				if (time) insertDetail(time);
				if (preview.kind === 'codeConversation' && preview.branch) {
					insertLoadedDetail(preview.branch, branch => detail(branch, 'branch'), time ?? null);
				}
				break;
			}
			case 'project': {
				const { details, paths } = preview;
				if (!details) break;
				const time = createPreviewTime(document, details.updatedAt);
				if (time) heading.append(' ', time);
				if (details.description?.trim()) insertDetail(h(document, 'div', details.description));
				if (paths) {
					for (const folder of paths.folders) insertDetail(detail(createPreviewPath(document, paths.formatPath(folder)), 'path'));
				}
				const count = detail(formatPreviewChatCount(details.conversationCount), 'count');
				insertDetail(count);
				if (details.description === undefined && details.descriptionSource) {
					insertLoadedDetail(details.descriptionSource, description => h(document, 'div', description), count);
				}
				break;
			}
		}
		return card;
	};
}

function createPreviewPath(document: Document, { label, basename }: PreviewPathLabel): HTMLElement {
	const home = label.startsWith('~/') ? label.slice(0, 2) : '';
	const path = label.slice(home.length);
	// Keep the final directory and its separator together when the parent path shrinks.
	const nameStart = path.lastIndexOf(basename);
	const separator = path[nameStart - 1];
	const split = separator === '/' || separator === '\\' ? nameStart - 1 : 0;
	const components = h(document, 'span', { className: 'ash-sessions-list-preview-path-components' },
		h(document, 'span', { className: 'ash-sessions-list-preview-path-prefix' }, path.slice(0, split)),
		h(document, 'span', { className: 'ash-sessions-list-preview-path-suffix' }, path.slice(split)),
	);
	const row = h(document, 'span', { className: 'ash-sessions-list-preview-path-text', attributes: { dir: 'ltr' } });
	if (home) row.append(h(document, 'span', { className: 'ash-sessions-list-preview-path-home' }, home));
	row.append(components);
	return row;
}

function formatPreviewChatCount(count: number): string {
	const formattedCount = new Intl.NumberFormat(getNLSLanguage()).format(count);
	return count === 1
		? localize('sessions.hover.conversationCountOne', '{0} chat', formattedCount)
		: localize('sessions.hover.conversationCount', '{0} chats', formattedCount);
}

function createPreviewTime(document: Document, timestamp: number | undefined): HTMLElement | undefined {
	const updatedAt = new Date(timestamp ?? NaN);
	const updatedAtMs = updatedAt.getTime();
	if (!Number.isFinite(updatedAtMs)) return undefined;
	const formatter = new Intl.RelativeTimeFormat(getNLSLanguage(), { numeric: 'auto' });
	const label = formatTimeAgo(updatedAtMs, Date.now(), formatter) ?? formatter.format(0, 'second');
	return h(document, 'time', { attributes: { datetime: updatedAt.toISOString() } }, label);
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
	if (!current || !currentChat || current.providerId !== session.providerId) {
		return undefined;
	}
	// An unopened Thread can report its checkout before the catalog hydrates its workspace.
	const expectedWorkspace = currentChat.workspace === undefined ? catalogWorkspace : workspace;
	if (agentHostSessionWorkspaceKey(chatExecutionWorkspace(current, currentChat)) !== agentHostSessionWorkspaceKey(expectedWorkspace)) {
		return undefined;
	}
	const head = repositories.status === 'fulfilled' && repositories.value?.length === 1 ? repositories.value[0].head : undefined;
	return {
		branch: head?.type === 'branch' && head.name ? localize('sessions.hover.branch', 'Branch: {0}', head.name) : undefined,
		changes: changes.status === 'fulfilled' ? changes.value : undefined,
	};
}
