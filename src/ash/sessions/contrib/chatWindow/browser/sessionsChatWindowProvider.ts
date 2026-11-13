import type { URI } from '../../../../base/common/uri.js';
import type { IChatWindowContent, IChatWindowProvider } from '../../../../workbench/contrib/chatWindow/browser/chatWindow.js';
import { sessionResource } from '../../../browser/chatHistoryModel.js';
import type { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { canOpenThreadInCode } from '../../../services/sessions/common/session.js';
import type { SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';

/** Resolves resources against the host's retained views as drafts become durable chats. */
export class SessionsChatWindowProvider<TView> implements IChatWindowProvider {
	constructor(
		private readonly views: ReadonlyMap<string, TView>,
		private readonly getSelection: (view: TView) => SessionsViewSelection,
		private readonly createContent: (view: TView) => IChatWindowContent,
		readonly prepareChat?: (chat: URI) => Promise<void>,
		readonly createChat?: (chat: URI) => URI | undefined,
		readonly getChats?: IChatWindowProvider['getChats'],
	) { }

	resolveContent(chat: URI): IChatWindowContent | undefined {
		const key = chat.toString();
		for (const view of this.views.values()) {
			if (getSessionChatResource(this.getSelection(view)).toString() === key) {
				return this.createContent(view);
			}
		}
		return undefined;
	}
}

export function getSessionChatWindowChoices(sessions: ISessionsManagementService, allThreads: boolean): ReturnType<NonNullable<IChatWindowProvider['getChats']>> {
	const drafts = sessions.untitledSessions.map(session => ({
		resource: getSessionChatResource({ kind: 'untitled', session }),
		title: session.title,
	}));
	const chats = sessions.sessions.filter(session => session.status === 'active').flatMap(session => {
		const active = session.chats.filter(chat => allThreads ? chat.status === 'active' : canOpenThreadInCode(session, chat));
		const available = allThreads ? active : [active.find(chat => chat.origin.type === 'root') ?? active[0]].filter(chat => chat !== undefined);
		return available.map(chat => ({
			resource: getSessionChatResource({ kind: 'session', active: { session, threadId: chat.threadId } }),
			title: chat.title || session.title,
			description: chat.origin.type === 'root' ? undefined : session.title,
		}));
	});
	return [...drafts, ...chats];
}

export function getSessionChatResource(selection: SessionsViewSelection): URI {
	if (selection.kind === 'untitled') return sessionResource('draft', selection.session.untitledSessionId);
	const { session, threadId } = selection.active;
	const resource = sessionResource('thread', session.sessionId, threadId);
	// A side slot can retain its own view of the same thread as the main slot.
	return selection.sideThread ? resource.with({ fragment: 'sideThread' }) : resource;
}

export function readSessionChatResource(resource: URI): { readonly draftId: string; } | { readonly sessionId: string; readonly threadId: string; readonly sideThread?: true; } | undefined {
	if (resource.scheme !== 'ash-agent-session' || resource.authority) return undefined;
	const match = /^\/(draft|thread)\/([^/]+)$/u.exec(resource.path);
	if (!match) return undefined;
	let id: string;
	try { id = decodeURIComponent(match[2]!); } catch { return undefined; }
	if (match[1] === 'draft') return { draftId: id };
	const threadId = new URLSearchParams(resource.query).get('threadId');
	if (threadId) return { sessionId: id, threadId, ...(resource.fragment === 'sideThread' ? { sideThread: true } : {}) };
	return undefined;
}
