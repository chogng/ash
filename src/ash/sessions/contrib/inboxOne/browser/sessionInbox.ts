import { addDisposableListener, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorPosition, ContextViewFocusRestore, ContextViewHideReason } from '../../../../base/browser/ui/contextview/contextview.js';
import type { IAction } from '../../../../base/common/actions.js';
import { equals } from '../../../../base/common/arrays.js';
import { findLast } from '../../../../base/common/arraysFind.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, observableFromEvent, observableValue, type IObservable, type IReader } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IAgentSessionsService } from '../../../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { SHOW_INBOX_NOTIFICATIONS_COMMAND_ID } from '../../../../workbench/contrib/sessions/browser/inboxNotificationsConstants.js';
import { IInboxNotificationsService, InboxNotificationActionKind, InboxNotificationsSortMode, InboxTab, isPullRequestNotificationKind, type IInboxNotificationItem } from '../../../../workbench/contrib/sessions/common/inboxNotificationsService.js';
import { ISessionsSidebarFooter } from '../../../browser/parts/sidebarPart.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IChatListCatalog } from '../../chat/browser/chatListModel.js';
import './media/sessionInbox.css';

const title = localize({ bundle: 'ash.sessions', key: 'sessions.inbox.title' }, 'Inbox');
const dismissedTitle = localize({ bundle: 'ash.sessions', key: 'sessions.inbox.dismissed' }, 'Dismissed Notifications');
const holdTitle = localize({ bundle: 'ash.sessions', key: 'sessions.inbox.onHold' }, 'Sessions on Hold');
const doneTitle = localize({ bundle: 'ash.sessions', key: 'sessions.inbox.done' }, 'Done Sessions');

type InboxView = 'attention' | 'dismissed' | InboxTab.OnHold | InboxTab.Done;
const viewTitles: Record<InboxView, string> = {
	attention: title,
	dismissed: dismissedTitle,
	[InboxTab.OnHold]: holdTitle,
	[InboxTab.Done]: doneTitle,
};

/** Projects conversations that need attention into the sidebar footer. */
export class SessionInbox extends Disposable {
	private readonly button: Button;
	private readonly mode: IObservable<'chat' | 'code'>;
	private readonly opening = this._register(new MutableDisposable());
	private panel: HTMLElement | undefined;
	private readonly view = observableValue<InboxView>(this, 'attention');
	private renderedItems: readonly IInboxNotificationItem[] = [];

	constructor(
		@ISessionsSidebarFooter private readonly sidebar: ISessionsSidebarFooter,
		@IAgentWorkbenchLayoutService layout: IAgentWorkbenchLayoutService,
		@IInboxNotificationsService private readonly inbox: IInboxNotificationsService,
		@IAgentSessionsService private readonly agentSessions: IAgentSessionsService,
		@IChatListCatalog private readonly chatCatalog: IChatListCatalog,
		@ISessionsService private readonly sessions: ISessionsService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
	) {
		super();
		const container = sidebar.footer;
		const sidebarVisible = observableFromEvent(this, layout.onDidChangePartVisibility, () => layout.isPartVisible('sidebar'));
		const document = container.ownerDocument;
		this.button = this._register(new Button(container, { ...defaultButtonStyles, label: title, icon: Lxicon.inbox, iconOnly: true, title }));
		this.button.domNode.classList.add('ash-sessions-inbox-button');
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this._register(contextKeys.createScoped(this.button.domNode)).createKey('sessionsInboxFocused', true);
		const dot = h(document, 'span', { className: 'ash-sessions-inbox-dot' });
		dot.setAttribute('aria-hidden', 'true');
		this.button.domNode.append(dot);
		this._register(this.button.onDidClick(() => {
			if (this.panel) this.contextViews.hide();
			else this.show();
		}));
		this._register(addDisposableListener(this.button.domNode, 'contextmenu', event => this.showOptions(event)));
		this._register(addDisposableListener(this.button.domNode, 'keydown', event => {
			if (isContextMenuKey(event)) this.showOptions(event);
		}));
		this._register(CommandsRegistry.register(SHOW_INBOX_NOTIFICATIONS_COMMAND_ID, () => {
			if (!layout.isPartVisible('sidebar')) layout.showPart('sidebar');
			if (layout.isPartVisible('sidebar') && !this.panel) this.show();
		}));
		this._register(MenusRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: {
				id: SHOW_INBOX_NOTIFICATIONS_COMMAND_ID,
				title: localize2({ bundle: 'ash.sessions', key: 'sessions.inbox.show' }, 'Show Inbox'),
			},
		}));

		const modeKey = new Set([SessionsWorkspaceModeContext.key]);
		const mode = this.mode = observableFromEvent(this, listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(modeKey)) listener(event);
		}), () => contextKeys.getValue<'chat' | 'code'>(SessionsWorkspaceModeContext.key) ?? 'chat');
		const attentionDemand = this._register(new MutableDisposable<IDisposable>());
		this._register(autorun(reader => {
			if (sidebarVisible.read(reader)) {
				// The footer still shows a live badge when the popover is closed.
				attentionDemand.value ??= this.inbox.acquireSessionAttention();
			} else {
				attentionDemand.clear();
			}
		}));
		this._register(autorun(reader => {
			const count = this.inbox.attentionCount.read(reader);
			const view = this.view.read(reader);
			const items = this.getItems(view, reader);
			const busy = view === 'attention' && this.inbox.isLoading.read(reader);
			dot.hidden = count === 0;
			this.button.domNode.setAttribute('aria-label', count
				? localize({ bundle: 'ash.sessions', key: 'sessions.inbox.count' }, 'Inbox, sessions needing attention: {0}', count)
				: title);
			if (this.panel) {
				if (this.panel.getAttribute('aria-busy') !== String(busy) || !equals(this.renderedItems, items, (left, right) =>
					left.id === right.id && left.title === right.title && left.description === right.description)) {
					this.render(this.panel, items, busy);
				}
			}
		}));
		this._register(autorun(reader => {
			mode.read(reader);
			sidebarVisible.read(reader);
			if (this.panel) this.contextViews.hide();
		}));
		this._register(toDisposable(() => { if (this.panel) this.contextViews.hide(); }));
	}

	private show(view: InboxView = 'attention'): void {
		if (this.panel) this.contextViews.hide();
		const button = this.button.domNode;
		const footer = this.sidebar.footer;
		const panel = h(button.ownerDocument, 'section', { className: 'ash-sessions-inbox' });
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', viewTitles[view]);
		panel.tabIndex = -1;
		this.view.set(view, undefined);
		this.render(panel, this.getItems(view), view === 'attention' && this.inbox.isLoading.get());
		const context = this.contextKeys.createScoped(panel);
		context.createKey('sessionsInboxFocused', true);
		const updateWidth = () => {
			const { width } = footer.getBoundingClientRect();
			panel.style.width = `calc(${width}px - 2 * (var(--ash-spacing-size120) + var(--ash-strokeThickness)))`;
		};
		updateWidth();
		const resizeFrame = new MutableDisposable();
		const resize = observeResize(footer, () => {
			// Updating the dialog also resizes the shared ContextView.
			resizeFrame.value = scheduleAtNextAnimationFrame(getWindow(footer), updateWidth);
		});
		this.panel = panel;
		this.button.focus();
		if (this.contextViews.show({
			// Center across the sidebar while keeping the vertical anchor on the button.
			anchor: {
				get left() {
					const { left, width } = footer.getBoundingClientRect();
					return left + width / 2;
				},
				get top() { return button.getBoundingClientRect().top; },
				width: 0,
				get height() { return button.getBoundingClientRect().height; },
			},
			anchorPosition: AnchorPosition.Above,
			anchorAlignment: AnchorAlignment.Center,
			content: panel,
			presentation: 'dialog',
			focusRestore: ContextViewFocusRestore.Previous,
			isTargetWithin: target => button.contains(target),
			onHide: () => {
				context.dispose();
				resize.dispose();
				resizeFrame.dispose();
				this.panel = undefined;
				this.renderedItems = [];
				this.button.toggleClassName('expanded', false);
				this.button.domNode.setAttribute('aria-expanded', 'false');
			},
		})) {
			this.button.toggleClassName('expanded', true);
			this.button.domNode.setAttribute('aria-expanded', 'true');
			(panel.querySelector('button') ?? panel).focus();
		}
	}

	private render(panel: HTMLElement, items: readonly IInboxNotificationItem[], loading: boolean): void {
		this.renderedItems = items;
		panel.setAttribute('aria-busy', String(loading));
		const document = panel.ownerDocument;
		const view = this.view.get();
		const heading = h(document, 'h2', viewTitles[view]);
		const focused = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.inboxEntry : undefined;
		const rows = items.map(item => {
			const row = h(document, 'button', { className: 'ash-sessions-inbox-row', properties: { type: 'button' } });
			row.dataset.inboxEntry = view === 'attention' && !isPullRequestNotificationKind(item.kind) ? item.chatResource?.toString() ?? item.id : item.id;
			row.append(h(document, 'span', item.title), h(document, 'span', { className: 'ash-sessions-inbox-status' }, item.description));
			row.onclick = () => {
				if (item.actions.some(action => action.primary && action.kind === InboxNotificationActionKind.OpenSession)) {
					void this.open(item, view).catch(onUnexpectedError);
				}
			};
			row.oncontextmenu = event => this.showItemActions(event, row, item);
			row.onkeydown = event => { if (isContextMenuKey(event)) this.showItemActions(event, row, item); };
			return row;
		});
		const empty = view === 'dismissed'
			? localize({ bundle: 'ash.sessions', key: 'sessions.inbox.noDismissed' }, 'No dismissed notifications.')
			: loading ? localize('sessions.empty.loading', 'Loading sessions')
				: view === 'attention' ? localize({ bundle: 'ash.sessions', key: 'sessions.inbox.empty' }, 'No conversations need your attention.')
					: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.noSessions' }, 'No sessions in this view.');
		panel.replaceChildren(heading, ...(rows.length ? rows : [h(document, 'p', empty)]));
		if (focused) (rows.find(row => row.dataset.inboxEntry === focused) ?? rows[0] ?? panel).focus();
	}

	private getItems(view: InboxView, reader?: IReader): readonly IInboxNotificationItem[] {
		if (view === 'dismissed') return this.inbox.dismissedNotifications.read(reader);
		const rows = this.inbox.sessionRows.read(reader);
		if (view !== 'attention') return rows.filter(row => row.tab === view);
		const attention = this.inbox.sessionAttention.read(reader);
		const notificationIds = new Set([...attention.values()].flatMap(entry => entry.notificationIds));
		const suppressed = new Set(rows.filter(row => row.tab === InboxTab.OnHold || row.tab === InboxTab.Done).map(row => row.id));
		return this.inbox.notifications.read(reader).filter(item =>
			notificationIds.has(item.id) && item.sessionResource && !suppressed.has(item.sessionResource.toString()));
	}

	private async open(item: IInboxNotificationItem, view: InboxView): Promise<void> {
		if (!item.chatResource || !this.getItems(view).some(entry => entry.id === item.id)) return;
		const projection = this.agentSessions.getSession(item.chatResource);
		const target = projection?.target;
		if (!projection || !target || !('sessionId' in target) || !target.threadId || projection.isArchived()) return;
		const chatMode = this.mode.get() === 'chat';
		const chatEntry = chatMode ? findLast(this.chatCatalog.sources.flatMap(source => source.snapshot.get().entries),
			entry => entry.sessionId === target.sessionId) : undefined;
		if (chatMode && !chatEntry) return;
		if (this.panel) this.contextViews.hide();
		const controller = new AbortController();
		const opening = this.opening.value = toDisposable(() => controller.abort());
		try {
			if (chatEntry) await chatEntry.open(controller.signal, target.threadId);
			else await this.sessions.openSession(target.sessionId, target.threadId, { reveal: 'code' });
		} finally {
			if (this.opening.value === opening) this.opening.clear();
		}
	}

	private showOptions(event: MouseEvent | KeyboardEvent): void {
		const sort = this.inbox.sortMode.get();
		const sortActions = [
			[InboxNotificationsSortMode.Priority, localize({ bundle: 'ash.sessions', key: 'sessions.inbox.sortPriority' }, 'Sort by Priority')],
			[InboxNotificationsSortMode.Recency, localize({ bundle: 'ash.sessions', key: 'sessions.inbox.sortRecency' }, 'Sort by Recency')],
		] as const;
		const historyViews = ['dismissed', InboxTab.OnHold, InboxTab.Done] as const;
		this.showMenu(event, this.button.domNode, [
			...sortActions.map(([mode, label]) => ({
				id: mode, label, tooltip: '', enabled: true, checked: mode === sort,
				run: () => { this.inbox.setSortMode(mode); this.show(); },
			})),
			...historyViews.map(view => ({
				id: view, label: viewTitles[view], tooltip: '', enabled: this.getItems(view).length > 0,
				run: () => this.show(view),
			})),
		]);
	}

	private showItemActions(event: MouseEvent | KeyboardEvent, row: HTMLElement, item: IInboxNotificationItem): void {
		const view = this.view.get();
		const session = this.inbox.sessionRows.get().find(row => row.id === item.sessionResource?.toString());
		const actions = item.actions.filter(action => view !== 'dismissed' || action.kind === InboxNotificationActionKind.OpenSession);
		const markDone = view === 'attention' && session?.actions.find(action => action.kind === InboxNotificationActionKind.MarkDone);
		const menuActions: IAction[] = [...actions, ...(markDone ? [markDone] : [])].map(action => ({
			id: action.id, label: action.label, tooltip: '', enabled: true,
			run: () => {
				if (action.kind === InboxNotificationActionKind.OpenSession) return this.open(item, view);
				if (!this.getItems(view).some(entry => entry.id === item.id)) return;
				if (action.kind === InboxNotificationActionKind.Dismiss) this.inbox.dismissNotification(item.id, item);
				else if (session && action.kind === InboxNotificationActionKind.MarkDone) this.inbox.markSessionDone(session);
				this.show();
			},
		}));
		if (session && (view === 'attention' || view === InboxTab.OnHold)) {
			const held = session.tab === InboxTab.OnHold;
			menuActions.push({
				id: 'holdSession',
				label: held ? localize({ bundle: 'ash.sessions', key: 'sessions.inbox.resume' }, 'Resume Session')
					: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.hold' }, 'Put Session on Hold'),
				tooltip: '', enabled: true,
				run: () => {
					if (!this.getItems(view).some(entry => entry.id === item.id)) return;
					this.inbox.setSessionOnHold(session, !held);
					this.show();
				},
			});
		}
		this.showMenu(event, row, menuActions);
	}

	private showMenu(event: MouseEvent | KeyboardEvent, anchor: HTMLElement, actions: readonly IAction[]): void {
		event.preventDefault();
		event.stopPropagation();
		// The menu replaces the popover, so keep an anchor independent of its rows.
		const { left, bottom } = anchor.getBoundingClientRect();
		const targetWindow = getWindow(anchor);
		this.contextMenus.showContextMenu({
			getAnchor: () => ({ x: left, y: bottom, targetWindow }),
			getActions: () => actions,
			autoSelectFirstItem: true,
			onHide: (cancelled, reason) => {
				if (cancelled && reason === ContextViewHideReason.Escape) this.button.focus();
			},
		});
	}
}

function isContextMenuKey(event: KeyboardEvent): boolean {
	return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}
