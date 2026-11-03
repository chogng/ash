import { ISessionsListModelService } from '../services/sessions/browser/sessionsListModelService.js';
import { Event } from '../../base/common/event.js';
import { URI } from '../../base/common/uri.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import type { IAgentSessionsService } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import type { IAgentSession, IAgentSessionsModel } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsModel.js';
import { getInProgressSessionDescription } from '../../workbench/contrib/chat/browser/chatSessions/chatSessionDescription.js';
import { ChatEditorInput } from '../../workbench/contrib/chat/browser/widgetHosts/editor/chatEditorInput.js';
import { ISessionGroupsService } from '../services/sessions/browser/sessionGroupsService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { sessionManagementLabel } from './sessionManagementLabels.js';

/** Opaque catalog identity; opening always returns to the host's captured Session/Thread target. */
function sessionResource(kind: 'draft' | 'session' | 'thread', id: string, threadId?: string): URI {
	return URI.from({ scheme: 'ash-agent-session', path: `/${kind}/${encodeURIComponent(id)}`, query: threadId === undefined ? '' : new URLSearchParams({ threadId }).toString() });
}

/** Projects the existing owner once for both presentations, retaining no second catalog or selection. */
export class ChatHistoryModel implements IAgentSessionsService, IAgentSessionsModel {
	readonly model: IAgentSessionsModel = this;
	readonly onDidChangeSessions: Event<void>;

	constructor(
		@ISessionsManagementService private readonly owner: ISessionsManagementService,
		@ISessionsListModelService private readonly listModel: ISessionsListModelService,
		@ISessionGroupsService private readonly groups: ISessionGroupsService,
		@ICommandService private readonly commands: ICommandService,
	) {
		this.onDidChangeSessions = Event.any(owner.onDidChange, groups.onDidChange, listModel.onDidChange);
	}

	get state(): IAgentSessionsModel['state'] {
		return this.owner.state === 'loading' ? 'loading' : this.owner.state === 'error' ? 'error' : 'ready';
	}

	get error(): string | undefined { return this.owner.error; }
	refresh(): Promise<void> { return this.owner.refresh(); }

	getSession(resource: URI): IAgentSession | undefined {
		const key = resource.toString();
		for (const session of this.sessions) {
			if (session.resource.toString() === key) return session;
			const chat = session.children?.find(child => child.resource.toString() === key);
			if (chat) return chat;
		}
		return undefined;
	}

	get sessions(): readonly IAgentSession[] {
		const records: IAgentSession[] = this.owner.untitledSessions.map(draft => ({
			id: `draft:${draft.untitledSessionId}`, resource: sessionResource('draft', draft.untitledSessionId),
			label: draft.title.trim(), description: '', kind: 'draft', target: { untitledSessionId: draft.untitledSessionId },
			active: this.owner.activeUntitledSession?.untitledSessionId === draft.untitledSessionId,
			isArchived: () => false, isPinned: () => false,
			getEditorInput: () => new ChatEditorInput(`untitled:${draft.untitledSessionId}`, draft.title),
			open: () => { this.owner.selectUntitledSession(draft.untitledSessionId); },
		}));
		for (const session of this.owner.sessions) {
			const archived = session.status === 'archived';
			const chats = session.chats.filter(chat => chat.status === 'active');
			const selected = this.owner.active?.session.sessionId === session.sessionId ? this.owner.active.threadId : undefined;
			const chat = chats.find(chat => chat.threadId === selected) ?? chats.find(chat => chat.origin.type === 'root') ?? chats[0];
			if (!archived && !chat) continue;
			const resource = sessionResource('session', session.sessionId);
			const label = session.title.trim();
			const pinned = this.listModel.isSessionPinned(session);
			const active = this.owner.activeUntitledSession === undefined && this.owner.active?.session.sessionId === session.sessionId;
			const activity = getInProgressSessionDescription(chat?.management ?? session.management);
			records.push({
				id: `${archived ? 'archived' : 'session'}:${session.sessionId}`, resource, label,
				description: [session.providerLabel, activity ?? session.workspace?.root].filter(Boolean).join(' · '),
				providerLabel: session.providerLabel, kind: 'session',
				target: { sessionId: session.sessionId, threadId: chat?.threadId }, active, inProgress: activity !== undefined,
				group: this.groups.groups.find(group => group.sessionIds.includes(session.sessionId)),
				isArchived: () => archived, isPinned: () => pinned,
				getEditorInput: () => new ChatEditorInput(`session:${session.sessionId}`, session.title),
				open: () => {
					if (archived) return this.commands.executeCommand<void>('agentSession.restore', session.sessionId);
					this.owner.selectThread(session.sessionId, chat!.threadId);
				},
				children: archived ? undefined : chats.map(thread => ({
					id: `thread:${session.sessionId}/${thread.threadId}`, resource: sessionResource('thread', session.sessionId, thread.threadId),
					label: thread.origin.type === 'root' ? label : thread.title?.trim() || label,
					description: getInProgressSessionDescription(thread.management) ?? (thread.management?.status === 'idle' ? '' : sessionManagementLabel(thread.management) ?? ''),
					kind: 'session', target: { sessionId: session.sessionId, threadId: thread.threadId },
					active: active && selected === thread.threadId, updatedAt: thread.updatedAt?.getTime(),
					parentSession: { resource, label }, isArchived: () => false, isPinned: () => pinned,
					open: () => { this.owner.selectThread(session.sessionId, thread.threadId); },
				})),
			});
		}
		return records;
	}
}
