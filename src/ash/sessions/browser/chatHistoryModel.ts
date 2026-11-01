import { Event } from '../../base/common/event.js';
import { Separator } from '../../base/common/actions.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { IViewsService } from '../../workbench/services/views/common/viewsService.js';
import { CHAT_VIEW_ID } from '../../workbench/contrib/chat/common/chat.js';
import { ForkConversationActionId } from '../../workbench/contrib/chat/browser/actions/chatForkActions.js';
import type {
	IAgentSessionsService,
	IAgentSessionsPickerModel,
	IAgentSessionPickerItem,
	IAgentSessionPickerAction,
} from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { sessionManagementLabel } from './sessionManagementLabels.js';
import { getNLSLanguage, localize } from '../../nls.js';
import { Lxicon } from '../../base/common/lxicons.js';
import type { IQuickPickItem, IQuickPickSeparator } from '../../platform/quickinput/common/quickInput.js';
import type { SessionId, ThreadId } from '../services/sessions/common/session.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { StorageScope, IStorageService } from '../../platform/storage/common/storage.js';
import { getInProgressSessionDescription } from '../../workbench/contrib/chat/browser/chatSessions/chatSessionDescription.js';
import { sessionDateFromNow } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsViewer.js';
import {
	ChatSessionArchiveActionWordingSettingId,
	getChatSessionArchiveActionPresentation,
	getChatSessionArchiveActionWording,
	getChatSessionArchivedSectionLabel,
} from '../../platform/chat/common/sessionArchiveActions.js';

type ChatHistoryQuickPickItem = IQuickPickItem & { readonly pinned: boolean; readonly updatedAt?: number; } & (
	{ readonly kind: 'draft'; readonly untitledSessionId: string; }
	| { readonly kind: 'thread'; readonly sessionId: SessionId; readonly threadId: ThreadId; }
	| { readonly kind: 'archived'; readonly sessionId: SessionId; }
);

function historyItemKey(item: ChatHistoryQuickPickItem): string {
	if (item.kind === 'draft') return `draft:${item.untitledSessionId}`;
	return item.kind === 'archived' ? `archived:${item.sessionId}` : `thread:${item.sessionId}/${item.threadId}`;
}

function historyItemTarget(item: ChatHistoryQuickPickItem): string | { readonly untitledSessionId: string; } {
	return item.kind === 'draft' ? { untitledSessionId: item.untitledSessionId } : item.sessionId;
}

function chatHistoryItems(sessions: ISessionsManagementService, storage: IStorageService, configuration: IConfigurationService): readonly (ChatHistoryQuickPickItem | IQuickPickSeparator)[] {
	const dates = new Intl.DateTimeFormat(getNLSLanguage(), { dateStyle: 'medium', timeStyle: 'medium' });
	const wording = getChatSessionArchiveActionWording(configuration);
	const presentation = getChatSessionArchiveActionPresentation(wording);
	const buttons = (pinned: boolean, archived = false) => [
		archived
			? { id: 'restore', label: presentation.unarchive.title.value, iconClass: `ash-icon-${presentation.unarchive.icon.id}` }
			: { id: 'pin', label: pinned ? localize('sessions.history.unpin', 'Unpin session') : localize('sessions.history.pin', 'Pin session'), iconClass: `ash-icon-${(pinned ? Lxicon.unpin : Lxicon.pin).id}` },
		{ id: 'more', label: localize('sessions.history.more', 'More session actions'), iconClass: `ash-icon-${Lxicon.toolBarMore.id}`, hasPopup: 'menu' as const },
	];
	const items: ChatHistoryQuickPickItem[] = sessions.untitledSessions.map(session => ({
		kind: 'draft', untitledSessionId: session.untitledSessionId,
		label: localize('sessions.list.draft', '{0} (draft)', session.title.trim() || localize('chat.title.new', 'New Chat')),
		pinned: false, buttons: buttons(false),
	}));
	const archived: ChatHistoryQuickPickItem[] = [];
	for (const session of sessions.sessions) {
		if (session.status === 'archived') {
			// Restore is Session-scoped and reopens only its canonical root conversation.
			archived.push({
				kind: 'archived', sessionId: session.sessionId,
				label: session.title.trim() || localize('chat.title.default', 'Chat'),
				pinned: false, buttons: buttons(false, true),
				detail: localize('sessions.history.restoreHint', '{0}. Press Enter to {1}.', getChatSessionArchivedSectionLabel(wording), presentation.unarchive.title.value),
			});
			continue;
		}
		const pinned = storage.getBoolean(`sessions.list.pinned.${session.sessionId}`, StorageScope.PROFILE, false);
		const threads = session.chats.filter(thread => thread.status === 'active');
		for (const [index, thread] of threads.entries()) {
			const label = session.title.trim() || localize('chat.title.default', 'Chat');
			const updatedAt = thread.updatedAt?.getTime();
			const date = updatedAt === undefined ? undefined : dates.format(updatedAt);
			items.push({
				kind: 'thread', sessionId: session.sessionId, threadId: thread.threadId,
				label, pinned, updatedAt, buttons: buttons(pinned),
				description: updatedAt === undefined ? undefined : sessionDateFromNow(updatedAt, true),
				tooltip: date ? `${label}\n${localize('sessions.history.lastActivity', 'Last activity: {0}', date)}` : label,
				detail: [
					threads.length > 1 ? localize('sessions.history.thread', 'Thread {0}', index + 1) : undefined,
					thread.origin.type !== 'root' && thread.title?.trim() !== label ? thread.title?.trim() : undefined,
					getInProgressSessionDescription(thread.management) ?? (thread.management?.status === 'idle' ? undefined : sessionManagementLabel(thread.management)),
				].filter(Boolean).join(' · ') || undefined,
			});
		}
	}
	const pinned = items.filter(item => item.pinned);
	const recent = items.filter(item => !item.pinned).sort((left, right) => {
		if (left.kind === 'draft' || right.kind === 'draft') return Number(right.kind === 'draft') - Number(left.kind === 'draft');
		return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
	});
	return [
		...(pinned.length ? [{ type: 'separator' as const, label: localize('sessions.list.pinned', 'Pinned'), presentation: 'section' as const }, ...pinned] : []),
		...(recent.length ? [{ type: 'separator' as const, label: localize('sessions.history.recent', 'Recent'), presentation: 'section' as const }, ...recent] : []),
		...(archived.length ? [{ type: 'separator' as const, label: getChatSessionArchivedSectionLabel(wording), presentation: 'section' as const }, ...archived] : []),
	];
}

/** Adapts the existing Session catalog and commands; no picker, DOM, or retained catalog lives here. */
export class ChatHistoryModel implements IAgentSessionsService {
	readonly model: IAgentSessionsPickerModel;

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IStorageService private readonly storage: IStorageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ICommandService private readonly commands: ICommandService,
		@IViewsService private readonly views: IViewsService,
	) {
		const owner = this;
		this.model = {
			onDidChange: Event.any(
				sessions.onDidChange,
				listener => configuration.onDidChangeConfiguration(event => {
					if (event.affectsConfiguration(ChatSessionArchiveActionWordingSettingId)) listener();
				}),
				listener => storage.onDidChangeValue(event => {
					if (event.scope === StorageScope.PROFILE && event.key.startsWith('sessions.list.pinned.')) listener();
				}),
			),
			get items() { return owner.items(); },
		};
	}

	private items(): readonly (IAgentSessionPickerItem | IQuickPickSeparator)[] {
		return chatHistoryItems(this.sessions, this.storage, this.configuration).map(item => 'type' in item ? item : {
			...item,
			id: historyItemKey(item),
			open: () => {
				if (item.kind === 'archived') return this.commands.executeCommand<void>('agentSession.restore', item.sessionId);
				if (item.kind === 'draft') this.sessions.selectUntitledSession(item.untitledSessionId);
				else this.sessions.selectThread(item.sessionId, item.threadId);
				void this.views.focusView(CHAT_VIEW_ID).catch(onUnexpectedError);
			},
			getActions: () => this.actions(item),
			getButtonAction: id => id === 'more' ? undefined : this.actions(item, true).find(action => action.id === id),
		});
	}

	private actions(item: ChatHistoryQuickPickItem, buttons = false): readonly IAgentSessionPickerAction[] {
		const presentation = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(this.configuration));
		const run = async (command: string, target: unknown = historyItemTarget(item)): Promise<string | void> => {
			const sessionId = await this.commands.executeCommand<unknown>(command, target);
			if (command !== 'sessions.list.togglePin' && item.kind !== 'archived') return;
			const targetSessionId = typeof sessionId === 'string' ? sessionId : item.kind === 'archived' ? item.sessionId : undefined;
			const targetItem = chatHistoryItems(this.sessions, this.storage, this.configuration).find(candidate => !('type' in candidate)
				&& candidate.kind === 'thread' && candidate.sessionId === targetSessionId
				&& (item.kind !== 'thread' || candidate.threadId === item.threadId));
			if (targetItem && !('type' in targetItem)) return historyItemKey(targetItem);
		};
		if (buttons && item.kind !== 'archived') {
			return [{ id: 'pin', label: '', tooltip: '', enabled: true, keepPickerOpen: true, run: () => run('sessions.list.togglePin') }];
		}
		if (item.kind === 'archived') {
			return [
				{ id: 'restore', label: presentation.unarchive.title.value, tooltip: '', enabled: true, run: () => run('agentSession.restore') },
				new Separator(),
				{ id: 'delete', label: localize('sessions.list.delete', 'Delete'), tooltip: '', enabled: true, run: () => run('agentSession.delete') },
			];
		}
		const draft = item.kind === 'draft' ? this.sessions.untitledSessions.find(session => session.untitledSessionId === item.untitledSessionId) : undefined;
		return [
			{ id: 'rename', label: localize('sessions.list.rename', 'Rename'), tooltip: '', enabled: true, run: () => run('agentSession.rename') },
			{
				id: 'fork', label: localize('sessions.history.fork', 'Fork'), tooltip: '', enabled: item.kind === 'thread',
				run: () => item.kind === 'thread' ? run(ForkConversationActionId, { sessionId: item.sessionId, threadId: item.threadId }) : undefined,
			},
			new Separator(),
			{ id: 'archive', label: presentation.archive.title.value, tooltip: '', enabled: true, run: () => run('agentSession.archive') },
			{
				id: 'delete', label: localize('sessions.list.delete', 'Delete'), tooltip: '', enabled: item.kind === 'thread' || draft !== undefined,
				run: () => run('agentSession.delete', draft ? { kind: 'untitled', session: draft } : historyItemTarget(item)),
			},
		];
	}
}
