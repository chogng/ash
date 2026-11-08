import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAlignment, AnchorPosition, ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { equals } from '../../../../base/common/arrays.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { combinedDisposable, Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, derived, observableFromEvent, observableSignalFromEvent, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ISessionsSidebarFooter } from '../../../browser/parts/sidebarPart.js';
import { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { IChatListCatalog, type ChatListEntry } from '../../chat/browser/chatListModel.js';
import { getRecencyEntryKey, type SessionRecencyEntry } from '../../../services/sessions/browser/sessionsRecencyHistory.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import './media/sessionInbox.css';

const title = localize({ bundle: 'ash.sessions', key: 'sessions.inbox.title' }, 'Inbox');
const statuses = {
	needsInput: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.needsInput' }, 'Needs your input'),
	failed: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.failed' }, 'Failed'),
	unread: localize({ bundle: 'ash.sessions', key: 'sessions.inbox.unread' }, 'Unread reply'),
};

interface InboxItem extends SessionRecencyEntry {
	readonly label: string;
	readonly status: keyof typeof statuses;
	readonly timestamp: number;
	readonly chatEntry?: ChatListEntry;
}

/** Projects conversations that need attention into the sidebar footer. */
export class SessionInbox extends Disposable {
	private readonly button: Button;
	private readonly items: IObservable<readonly InboxItem[]>;
	private readonly opening = this._register(new MutableDisposable());
	private panel: HTMLElement | undefined;
	private renderedItems: readonly InboxItem[] = [];

	constructor(
		@ISessionsSidebarFooter sidebar: ISessionsSidebarFooter,
		@IAgentWorkbenchLayoutService layout: IAgentWorkbenchLayoutService,
		@ISessionsManagementService catalog: ISessionsManagementService,
		@ISessionsService private readonly sessions: ISessionsService,
		@IChatListCatalog chatCatalog: IChatListCatalog,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextViewService private readonly contextViews: IContextViewService,
	) {
		super();
		const container = sidebar.footer;
		const sidebarVisible = observableFromEvent(this, layout.onDidChangePartVisibility, () => layout.isPartVisible('sidebar'));
		const codeVisible = observableFromEvent(this, layout.onDidChangePartVisibility, () => layout.isPartVisible('sessions'));
		const document = container.ownerDocument;
		const window = getWindow(document);
		this.button = this._register(new Button(container, { ...defaultButtonStyles, label: title, icon: Lxicon.inbox, iconOnly: true, title }));
		this.button.domNode.classList.add('ash-sessions-inbox-button');
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this._register(contextKeys.createScoped(this.button.domNode)).createKey('sessionsInboxFocused', true);
		const dot = h(document, 'span', { className: 'ash-sessions-inbox-dot' });
		dot.setAttribute('aria-hidden', 'true');
		this.button.domNode.append(dot);
		this._register(this.button.onDidClick(() => this.toggle()));

		const modeKey = new Set([SessionsWorkspaceModeContext.key]);
		const mode = observableFromEvent(this, listener => contextKeys.onDidChangeContext(event => {
			if (event.affectsSome(modeKey)) listener(event);
		}), () => contextKeys.getValue<'chat' | 'code'>(SessionsWorkspaceModeContext.key) ?? 'chat');
		const focused = observableFromEvent(this, listener => combinedDisposable(
			addDisposableListener(window, 'focus', listener),
			addDisposableListener(window, 'blur', listener),
			addDisposableListener(document, 'visibilitychange', listener),
		), () => !document.hidden && document.hasFocus());
		const changed = observableSignalFromEvent(this, sessions.onDidChange);
		const chatEntries = derived(reader => mode.read(reader) === 'chat'
			? chatCatalog.sources.flatMap(source => source.snapshot.read(reader).entries).filter(entry => entry.sessionId !== undefined)
			: []);
		const foreground = derived<SessionRecencyEntry | undefined>(reader => {
			if (!focused.read(reader)) return;
			if (mode.read(reader) === 'code') {
				if (!codeVisible.read(reader)) return;
				const selection = sessions.getSelection(reader).activeSelection;
				if (selection?.kind === 'session') return { sessionId: selection.active.session.sessionId, threadId: selection.active.threadId };
			} else {
				const selected = chatEntries.read(reader).find(entry => entry.selectedThreadId !== undefined);
				if (selected?.sessionId && selected.selectedThreadId) return { sessionId: selected.sessionId, threadId: selected.selectedThreadId };
			}
		});
		this._register(autorun(reader => {
			changed.read(reader);
			const entry = foreground.read(reader);
			if (entry) sessions.markVisibleThreadViewed(entry);
		}));
		this.items = derived(reader => {
			changed.read(reader);
			const workspace = mode.read(reader);
			const active = foreground.read(reader);
			const chats = new Map(chatEntries.read(reader).map(entry => [entry.sessionId, entry]));
			const items: InboxItem[] = [];
			for (const session of catalog.sessions) {
				if (session.kind !== workspace || session.status !== 'active') continue;
				const chatEntry = chats.get(session.sessionId);
				if (workspace === 'chat' && !chatEntry) continue;
				const threads = session.chats.filter(thread => thread.status === 'active' && thread.origin.type !== 'agentSpawn');
				for (const thread of threads) {
					const entry = { sessionId: session.sessionId, threadId: thread.threadId };
					// Aggregate status cannot identify which of several conversations needs attention.
					const management = thread.management ?? (threads.length === 1 ? session.management : undefined);
					const activity = management?.status;
					const terminal = activity === 'completed' || activity === 'readyForReview' || activity === 'failed';
					const timestamp = management && (terminal || activity === 'needsInput') ? management.statusChangedAtUnixMs : thread.updatedAt?.getTime() ?? 0;
					const seen = active?.sessionId === entry.sessionId && active.threadId === entry.threadId
						|| timestamp <= (sessions.getLastViewedAt(entry) ?? 0);
					const execution = thread.executionStatus;
					const busy = activity === 'working' || execution === 'queued' || execution === 'running' || execution === 'waiting';
					let status: InboxItem['status'];
					if (activity === 'needsInput') status = 'needsInput';
					else if (seen || busy) continue;
					else if (activity === 'failed' || execution === 'failed') status = 'failed';
					else if (activity === 'completed' || activity === 'readyForReview' || execution === 'completed') status = 'unread';
					else continue;
					const label = thread.title?.trim() || session.title.trim() || localize('sessions.list.untitled', 'Untitled Session');
					items.push({ ...entry, label, status, timestamp, chatEntry });
				}
			}
			const priority = { needsInput: 0, failed: 1, unread: 2 };
			return items.sort((a, b) => priority[a.status] - priority[b.status] || b.timestamp - a.timestamp);
		});
		this._register(autorun(reader => {
			const items = this.items.read(reader);
			const count = items.length;
			dot.hidden = count === 0;
			this.button.domNode.setAttribute('aria-label', count
				? localize({ bundle: 'ash.sessions', key: 'sessions.inbox.count' }, 'Inbox, items needing attention: {0}', count)
				: title);
			if (this.panel && !equals(this.renderedItems, items, (left, right) => left.sessionId === right.sessionId
				&& left.threadId === right.threadId && left.label === right.label && left.status === right.status)) {
				this.render(this.panel, items);
			}
		}));
		this._register(autorun(reader => {
			mode.read(reader);
			sidebarVisible.read(reader);
			if (this.panel) this.contextViews.hide();
		}));
		this._register(toDisposable(() => { if (this.panel) this.contextViews.hide(); }));
	}

	private toggle(): void {
		if (this.panel) {
			this.contextViews.hide();
			return;
		}
		const panel = h(this.button.domNode.ownerDocument, 'section', { className: 'ash-sessions-inbox' });
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', title);
		panel.tabIndex = -1;
		this.render(panel, this.items.get());
		this.panel = panel;
		this.button.focus();
		if (this.contextViews.show({
			anchor: this.button.domNode,
			anchorPosition: AnchorPosition.Above,
			anchorAlignment: AnchorAlignment.Right,
			content: panel,
			presentation: 'dialog',
			focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => {
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

	private render(panel: HTMLElement, items: readonly InboxItem[]): void {
		this.renderedItems = items;
		const document = panel.ownerDocument;
		const heading = h(document, 'h2', title);
		const focused = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.inboxEntry : undefined;
		const rows = items.map(item => {
			const row = h(document, 'button', { className: 'ash-sessions-inbox-row', properties: { type: 'button' } });
			row.dataset.inboxEntry = getRecencyEntryKey(item);
			row.append(h(document, 'span', item.label), h(document, 'span', { className: 'ash-sessions-inbox-status' }, statuses[item.status]));
			row.onclick = () => {
				const current = this.items.get().find(entry => entry.sessionId === item.sessionId && entry.threadId === item.threadId);
				if (!current) return;
				this.contextViews.hide();
				const controller = new AbortController();
				const opening = this.opening.value = toDisposable(() => controller.abort());
				const open = current.chatEntry
					? current.chatEntry.open(controller.signal, current.threadId)
					: this.sessions.openSession(current.sessionId, current.threadId, { reveal: 'code' });
				void open.catch(onUnexpectedError).finally(() => { if (this.opening.value === opening) this.opening.clear(); });
			};
			return row;
		});
		panel.replaceChildren(heading, ...(rows.length ? rows : [h(document, 'p', localize({ bundle: 'ash.sessions', key: 'sessions.inbox.empty' }, 'No conversations need your attention.'))]));
		if (focused) (rows.find(row => row.dataset.inboxEntry === focused) ?? rows[0] ?? panel).focus();
	}
}
