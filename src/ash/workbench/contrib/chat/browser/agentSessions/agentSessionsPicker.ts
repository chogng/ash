import { isHTMLElement } from '../../../../../base/browser/dom.js';
import { Separator, type IAction } from '../../../../../base/common/actions.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { cancelOnDispose } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem, type IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IAgentSessionsService } from './agentSessionsService.js';
import type { IAgentSession } from './agentSessionsModel.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { CHAT_VIEW_ID } from '../../common/chat.js';
import { ForkConversationActionId } from '../actions/chatForkActions.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ChatSessionArchiveActionWordingSettingId, getChatSessionArchiveActionPresentation, getChatSessionArchiveActionWording, getChatSessionArchivedSectionLabel } from '../../../../../platform/chat/common/sessionArchiveActions.js';
import { sessionDateFromNow } from './agentSessionsViewer.js';

interface ISessionPickItem extends IQuickPickItem {
	readonly id: string;
	readonly session: IAgentSession;
}

interface ISessionPickerAction extends IAction {
	readonly keepPickerOpen?: boolean;
	run(): void | string | Promise<void | string>;
}


export interface IAgentSessionsPickerOptions {
	overrideSessionOpen?(session: IAgentSession): Promise<void>;
}

/** Owns one popup and its child menu; the host retains all catalog and operation state. */
export class AgentSessionsPicker {
	constructor(
		private readonly anchor: HTMLElement | undefined,
		private readonly options: IAgentSessionsPickerOptions | undefined,
		@IAgentSessionsService private readonly agentSessionsService: IAgentSessionsService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
		@ICommandService private readonly commands: ICommandService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IViewsService private readonly views: IViewsService,
	) { }

	pickAgentSession(): Promise<void> {
		const model = this.agentSessionsService.model;
		const disposables = new DisposableStore();
		const picker = disposables.add(this.quickInputService.createQuickPick<ISessionPickItem>());
		const dismissed = new DeferredPromise<void>();
		const cancellationToken = cancelOnDispose(disposables);
		let suspended = false;
		if (this.anchor) {
			picker.anchor = this.anchor;
			picker.width = 280;
			picker.anchorPosition = 'below';
			picker.anchorAlignment = 'right';
		}
		picker.sortByLabel = false;
		picker.ariaLabel = localize({ bundle: 'ash.sessions', key: 'command.ShowChatHistoryAction' }, 'Show Chat History');
		picker.placeholder = localize('sessions.history.placeholder', 'Select a conversation');
		const refresh = (preferredId = picker.activeItems[0]?.id): void => {
			if (suspended || picker.ignoreFocusOut || disposables.isDisposed) return;
			const items = this.items();
			picker.items = items;
			const active = items.find(item => !('type' in item) && item.id === preferredId);
			if (active && !('type' in active)) picker.activeItems = [active];
		};
		const runOperation = async (operation: () => unknown, closeOnSuccess = false, keepPickerOpen = false): Promise<void> => {
			if (suspended) return;
			if (keepPickerOpen) {
				picker.focus();
			} else {
				// A child prompt may take focus without ending this search's lifetime.
				suspended = true;
				picker.hide();
			}
			let succeeded = false;
			let preferredId: string | undefined;
			try {
				const result = await operation();
				preferredId = typeof result === 'string' ? result : undefined;
				succeeded = true;
			} catch (error) {
				this.notifications.error(String(error));
			} finally {
				suspended = false;
				if (!disposables.isDisposed) {
					if (succeeded && closeOnSuccess) {
						disposables.dispose();
						void dismissed.complete();
					} else {
						refresh(preferredId);
						if (!keepPickerOpen) picker.show();
					}
				}
			}
		};
		refresh();
		disposables.add(model.onDidChangeSessions(() => refresh()));
		disposables.add(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatSessionArchiveActionWordingSettingId)) refresh();
		}));
		disposables.add(picker.onDidTriggerItemButton(event => {
			const action = event.button.id === 'more' ? undefined : this.actions(event.item.session, true).find(action => action.id === event.button.id);
			if (action) {
				void runOperation(() => action.run(), false, action.keepPickerOpen);
				return;
			}
			if (!isHTMLElement(event.anchor)) return;
			const button = event.anchor;
			button.setAttribute('aria-expanded', 'true');
			picker.ignoreFocusOut = true;
			this.menus.showContextMenu({
				cancellationToken,
				// The child menu must be above the Quick Input that owns it.
				layer: 200,
				getAnchor: () => button,
				autoSelectFirstItem: true,
				getActions: () => this.actions(event.item.session).map(action => action instanceof Separator ? action : {
					...action,
					run: () => runOperation(() => action.run(), false, action.keepPickerOpen),
				}),
				onHide: () => {
					button.setAttribute('aria-expanded', 'false');
					picker.ignoreFocusOut = false;
					if (!suspended && !disposables.isDisposed) {
						refresh();
						picker.focus();
					}
				},
			});
		}));
		disposables.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;
			const session = this.agentSessionsService.getSession(item.session.resource);
			if (!session) { refresh(); return; }
			void runOperation(async () => {
				if (this.options?.overrideSessionOpen) await this.options.overrideSessionOpen(session);
				else {
					await session.open();
					await this.views.focusView(CHAT_VIEW_ID);
				}
			}, true);
		}));
		disposables.add(picker.onDidHide(() => {
			if (suspended) return;
			disposables.dispose();
			void dismissed.complete();
		}));
		picker.show();
		return dismissed.p;
	}
	private items(): readonly (ISessionPickItem | IQuickPickSeparator)[] {
		const dates = new Intl.DateTimeFormat(getNLSLanguage(), { dateStyle: 'medium', timeStyle: 'medium' });
		const wording = getChatSessionArchiveActionWording(this.configuration);
		const presentation = getChatSessionArchiveActionPresentation(wording);
		const items: ISessionPickItem[] = [];
		const archived: ISessionPickItem[] = [];
		for (const parent of this.agentSessionsService.model.sessions) {
			const sessions = parent.children?.length ? parent.children : [parent];
			for (const [index, session] of sessions.entries()) {
				const label = parent.label || localize('chat.title.default', 'Chat');
				const pinned = session.isPinned();
				const isArchived = session.isArchived();
				const date = session.updatedAt === undefined ? undefined : dates.format(session.updatedAt);
				const item: ISessionPickItem = {
					id: session.id, session,
					label: session.kind === 'draft' ? localize('sessions.list.draft', '{0} (draft)', session.label || localize('chat.title.new', 'New Chat')) : label,
					description: session.updatedAt === undefined ? undefined : sessionDateFromNow(session.updatedAt, true),
					tooltip: date ? `${label}\n${localize('sessions.history.lastActivity', 'Last activity: {0}', date)}` : label,
					detail: [
						parent.providerLabel,
						...(isArchived
							? [localize('sessions.history.restoreHint', '{0}. Press Enter to {1}.', getChatSessionArchivedSectionLabel(wording), presentation.unarchive.title.value)]
							: [
								sessions.length > 1 ? localize('sessions.history.thread', 'Thread {0}', index + 1) : undefined,
								session.parentSession && session.label !== parent.label ? session.label : undefined,
								session.parentSession ? session.description : undefined,
							]),
					].filter(Boolean).join(' · ') || undefined,
					buttons: [
						isArchived
							? { id: 'restore', label: presentation.unarchive.title.value, iconClass: `ash-icon-${presentation.unarchive.icon.id}` }
							: { id: 'pin', label: pinned ? localize('sessions.history.unpin', 'Unpin session') : localize('sessions.history.pin', 'Pin session'), iconClass: `ash-icon-${(pinned ? Lxicon.unpin : Lxicon.pin).id}` },
						{ id: 'more', label: localize('sessions.history.more', 'More session actions'), iconClass: `ash-icon-${Lxicon.toolBarMore.id}`, hasPopup: 'menu' },
					],
				};
				(isArchived ? archived : items).push(item);
			}
		}
		const pinned = items.filter(item => item.session.isPinned());
		const recent = items.filter(item => !item.session.isPinned()).sort((a, b) => {
			if (a.session.kind === 'draft' || b.session.kind === 'draft') return Number(b.session.kind === 'draft') - Number(a.session.kind === 'draft');
			return (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0);
		});
		return [
			...(pinned.length ? [{ type: 'separator' as const, label: localize('sessions.list.pinned', 'Pinned'), presentation: 'section' as const }, ...pinned] : []),
			...(recent.length ? [{ type: 'separator' as const, label: localize('sessions.history.recent', 'Recent'), presentation: 'section' as const }, ...recent] : []),
			...(archived.length ? [{ type: 'separator' as const, label: getChatSessionArchivedSectionLabel(wording), presentation: 'section' as const }, ...archived] : []),
		];
	}

	private actions(session: IAgentSession, buttons = false): readonly ISessionPickerAction[] {
		const presentation = getChatSessionArchiveActionPresentation(getChatSessionArchiveActionWording(this.configuration));
		const target = 'sessionId' in session.target ? session.target.sessionId : session.target;
		const run = async (command: string, argument: unknown = target): Promise<string | void> => {
			const id = await this.commands.executeCommand<unknown>(command, argument);
			if (command !== 'sessions.list.togglePin' && !session.isArchived()) return;
			const sessionId = typeof id === 'string' ? id : 'sessionId' in session.target ? session.target.sessionId : undefined;
			const parent = this.agentSessionsService.model.sessions.find(item => 'sessionId' in item.target && item.target.sessionId === sessionId && !item.isArchived());
			const previousThread = 'threadId' in session.target ? session.target.threadId : undefined;
			return parent?.children?.find(child => 'threadId' in child.target && child.target.threadId === previousThread)?.id ?? parent?.children?.[0]?.id;
		};
		if (buttons && !session.isArchived()) return [{ id: 'pin', label: '', tooltip: '', enabled: true, keepPickerOpen: true, run: () => run('sessions.list.togglePin') }];
		if (session.isArchived()) return [
			{ id: 'restore', label: presentation.unarchive.title.value, tooltip: '', enabled: true, run: () => run('agentSession.restore') },
			new Separator(),
			{ id: 'delete', label: localize('sessions.list.delete', 'Delete'), tooltip: '', enabled: true, run: () => run('agentSession.delete') },
		];
		return [
			{ id: 'rename', label: localize('sessions.list.rename', 'Rename'), tooltip: '', enabled: true, run: () => run('agentSession.rename') },
			{ id: 'fork', label: localize('sessions.history.fork', 'Fork'), tooltip: '', enabled: session.kind !== 'draft', run: () => run(ForkConversationActionId, session.target) },
			new Separator(),
			{ id: 'archive', label: presentation.archive.title.value, tooltip: '', enabled: true, run: () => run('agentSession.archive') },
			{ id: 'delete', label: localize('sessions.list.delete', 'Delete'), tooltip: '', enabled: true, run: () => run('agentSession.delete') },
		];
	}

}
