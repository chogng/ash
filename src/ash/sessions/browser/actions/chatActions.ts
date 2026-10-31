import './chatActions.css';
import { sessionManagementLabel } from '../sessionManagementLabels.js';
import { onUnexpectedError } from '../../../base/common/errors.js';
import { getNLSLanguage, localize, localize2 } from '../../../nls.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../base/common/async.js';
import { Separator } from '../../../base/common/actions.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem, type IQuickPickSeparator } from '../../../platform/quickinput/common/quickInput.js';
import type { SessionId, ThreadId } from '../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { IViewsService } from '../../../workbench/services/views/common/viewsService.js';
import { CHAT_VIEW_ID, NEW_CHAT_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID } from '../../../workbench/contrib/chat/common/chat.js';
import { getInProgressSessionDescription } from '../../../workbench/contrib/chat/browser/chatSessions/chatSessionDescription.js';
import { ChatContextKeys } from '../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { ChatAIDisabledSettingId } from '../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { isHTMLElement } from '../../../base/browser/dom.js';
import { IStorageService, StorageScope } from '../../../platform/storage/common/storage.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { cancelOnDispose } from '../../../base/common/cancellation.js';
import { sessionDateFromNow } from '../../../workbench/contrib/chat/browser/agentSessions/agentSessionsViewer.js';
import { ForkConversationActionId } from '../../../workbench/contrib/chat/browser/actions/chatForkActions.js';
import {
	ChatSessionArchiveActionWordingSettingId,
	getChatSessionArchiveActionPresentation,
	getChatSessionArchiveActionWording,
	getChatSessionArchivedSectionLabel,
} from '../../../platform/chat/common/sessionArchiveActions.js';

registerAction2(class NewChatAction extends Action2 {
	constructor() {
		super({
			id: NEW_CHAT_COMMAND_ID,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			title: localize2({ bundle: 'ash.sessions', key: 'command.NewChatAction' }, 'New Chat'),
			icon: Lxicon.add,
			f1: true,
			menu: {
				id: MenuId.ChatNewMenu,
				group: '1_open',
				order: 1,
				when: ChatContextKeys.enabled.isEqualTo(true),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<boolean> {
		if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId)) return Promise.resolve(false);
		const sessionService = accessor.get(ISessionsManagementService);
		const viewsService = accessor.get(IViewsService);
		sessionService.createUntitledSession();
		return viewsService.focusView(CHAT_VIEW_ID);
	}
});

MenusRegistry.appendMenuItem(MenuId.ChatTitle, {
	submenu: MenuId.ChatNewMenu,
	title: localize2({ bundle: 'ash.sessions', key: 'command.NewChatAction' }, 'New Chat'),
	isSplitButton: true,
	when: ChatContextKeys.enabled.isEqualTo(true),
	group: 'navigation',
	order: 1,
});

type ChatHistoryQuickPickItem = IQuickPickItem & { readonly pinned: boolean; readonly updatedAt?: number; } & (
	{ readonly kind: 'draft'; readonly untitledSessionId: string; }
	| { readonly kind: 'thread'; readonly sessionId: SessionId; readonly threadId: ThreadId; }
	| { readonly kind: 'archived'; readonly sessionId: SessionId; }
);

registerAction2(class ShowChatHistoryAction extends Action2 {
	constructor() {
		super({
			id: SHOW_CHAT_HISTORY_COMMAND_ID,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			title: localize2({ bundle: 'ash.sessions', key: 'command.ShowChatHistoryAction' }, 'Show Chat History'),
			tooltip: localize({ bundle: 'ash.sessions', key: 'command.ShowChatHistoryAction' }, 'Show Chat History'),
			icon: Lxicon.history,
			f1: true,
			menu: {
				id: MenuId.ChatTitle,
				group: 'navigation',
				order: 2,
			},
		});
	}

	override run(accessor: ServicesAccessor, anchor?: unknown): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return Promise.resolve();
		const sessions = accessor.get(ISessionsManagementService);
		const views = accessor.get(IViewsService);
		const storage = accessor.get(IStorageService);
		const commands = accessor.get(ICommandService);
		const menus = accessor.get(IContextMenuService);
		const notifications = accessor.get(INotificationService);
		const quickPick = accessor.get(IQuickInputService).createQuickPick<ChatHistoryQuickPickItem>();
		if (isHTMLElement(anchor)) {
			quickPick.anchor = anchor;
			quickPick.width = 280;
			quickPick.anchorPosition = 'below';
			quickPick.anchorAlignment = 'right';
		}
		const disposables = new DisposableStore();
		disposables.add(quickPick);
		const dismissed = new DeferredPromise<void>();
		const cancellationToken = cancelOnDispose(disposables);
		let suspended = false;
		quickPick.sortByLabel = false;
		quickPick.ariaLabel = localize({ bundle: 'ash.sessions', key: 'command.ShowChatHistoryAction' }, 'Show Chat History');
		quickPick.placeholder = localize('sessions.history.placeholder', 'Select a conversation');
		const refresh = (preferredSessionId?: string, preferredThreadId?: string): void => {
			if (suspended || quickPick.ignoreFocusOut || disposables.isDisposed) return;
			const active = quickPick.activeItems[0];
			const items = chatHistoryItems(sessions, storage, configuration);
			quickPick.items = items;
			const selected = items.find((item): item is ChatHistoryQuickPickItem => !('type' in item) && (preferredSessionId
				? item.kind === 'thread' && item.sessionId === preferredSessionId && (!preferredThreadId || item.threadId === preferredThreadId)
				: !!active && historyItemKey(item) === historyItemKey(active)));
			if (selected) quickPick.activeItems = [selected];
		};
		refresh();
		disposables.add(sessions.onDidChange(() => refresh()));
		disposables.add(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatSessionArchiveActionWordingSettingId)) refresh();
		}));
		disposables.add(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key.startsWith('sessions.list.pinned.')) refresh();
		}));
		const runSessionCommand = async (item: ChatHistoryQuickPickItem, command: string, target: unknown = historyItemTarget(item), keepOpen = true): Promise<void> => {
			if (suspended) return;
			// Keep the search alive while the shared command operates on the captured target.
			suspended = true;
			quickPick.hide();
			let succeeded = false;
			try { await commands.executeCommand(command, target); succeeded = true; }
			catch (error) { notifications.error(String(error)); }
			finally {
				suspended = false;
				if (!disposables.isDisposed) {
					if (succeeded && !keepOpen) {
						disposables.dispose();
						void dismissed.complete();
					} else {
						refresh(item.kind === 'archived' ? item.sessionId : undefined);
						quickPick.show();
					}
				}
			}
		};
		disposables.add(quickPick.onDidTriggerItemButton(event => {
			if (event.button.id === 'restore') {
				void runSessionCommand(event.item, 'agentSession.restore');
				return;
			}
			if (event.button.id === 'pin') {
				quickPick.focus();
				void commands.executeCommand<string>('sessions.list.togglePin', historyItemTarget(event.item))
					.then(sessionId => refresh(sessionId, event.item.kind === 'thread' ? event.item.threadId : undefined), error => notifications.error(String(error)));
				return;
			}
			if (!isHTMLElement(event.anchor)) return;
			const button = event.anchor;
			const row = button.closest('.ash-chat-history-item');
			const draftId = event.item.kind === 'draft' ? event.item.untitledSessionId : undefined;
			const draft = draftId === undefined ? undefined : sessions.untitledSessions.find(session => session.untitledSessionId === draftId);
			const presentation = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(configuration));
			row?.classList.add('has-open-actions');
			button.setAttribute('aria-expanded', 'true');
			quickPick.ignoreFocusOut = true;
			menus.showContextMenu({
				cancellationToken,
				// Context views start below Quick Input; this child menu belongs above its host.
				layer: 200,
				getAnchor: () => button,
				autoSelectFirstItem: true,
				getActions: () => event.item.kind === 'archived' ? [
					{ id: 'restore', label: presentation.unarchive.title.value, tooltip: '', enabled: true, run: () => runSessionCommand(event.item, 'agentSession.restore') },
					new Separator(),
					{ id: 'delete', label: localize('sessions.list.delete', 'Delete'), tooltip: '', enabled: true, run: () => runSessionCommand(event.item, 'agentSession.delete') },
				] : [
					{ id: 'rename', label: localize('sessions.list.rename', 'Rename'), tooltip: '', enabled: true, run: () => runSessionCommand(event.item, 'agentSession.rename') },
					{
						id: 'fork', label: localize('sessions.history.fork', 'Fork'), tooltip: '', enabled: event.item.kind === 'thread',
						run: () => {
							if (event.item.kind === 'thread') return runSessionCommand(event.item, ForkConversationActionId, { sessionId: event.item.sessionId, threadId: event.item.threadId });
						},
					},
					new Separator(),
					{ id: 'archive', label: presentation.archive.title.value, tooltip: '', enabled: true, run: () => runSessionCommand(event.item, 'agentSession.archive') },
					{
						id: 'delete', label: localize('sessions.list.delete', 'Delete'), tooltip: '', enabled: event.item.kind === 'thread' || draft !== undefined,
						run: () => runSessionCommand(event.item, 'agentSession.delete', draft ? { kind: 'untitled', session: draft } : historyItemTarget(event.item)),
					},
				],
				onHide: () => {
					row?.classList.remove('has-open-actions');
					button.setAttribute('aria-expanded', 'false');
					quickPick.ignoreFocusOut = false;
					if (!suspended && !disposables.isDisposed) { refresh(); quickPick.focus(); }
				},
			});
		}));
		disposables.add(quickPick.onDidAccept(() => {
			const item = quickPick.selectedItems[0];
			if (!item) return;
			if (item.kind === 'archived') {
				void runSessionCommand(item, 'agentSession.restore', item.sessionId, false);
				return;
			}

			if (item.kind === 'draft') sessions.selectUntitledSession(item.untitledSessionId);
			else sessions.selectThread(item.sessionId, item.threadId);
			quickPick.hide();
			void views.focusView(CHAT_VIEW_ID).catch(onUnexpectedError);

		}));
		disposables.add(quickPick.onDidHide(() => {
			if (suspended) return;
			disposables.dispose();
			void dismissed.complete();
		}));
		quickPick.show();
		return dismissed.p;
	}
});

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
		label: session.title.trim() || localize('chat.title.new', 'New Chat'),
		className: 'ash-chat-history-item', pinned: false, buttons: buttons(false),
	}));
	const archived: ChatHistoryQuickPickItem[] = [];
	for (const session of sessions.sessions) {
		if (session.status === 'archived') {
			// Restore is Session-scoped and reopens only its canonical root conversation.
			archived.push({
				kind: 'archived', sessionId: session.sessionId,
				label: session.title.trim() || localize('chat.title.default', 'Chat'),
				className: 'ash-chat-history-item', pinned: false, buttons: buttons(false, true),
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
				label, pinned, updatedAt, className: 'ash-chat-history-item', buttons: buttons(pinned),
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
