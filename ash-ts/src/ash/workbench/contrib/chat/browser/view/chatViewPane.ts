import "../media/chat.css";
import { setDisposableOwner, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { IMenuService } from "../../../../../platform/actions/common/menuService.js";
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../../../platform/contextview/browser/contextView.js";
import type { ICommandService } from "../../../../../platform/commands/common/commands.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../../browser/parts/views/viewPane.js";
import type { IWorkbenchLayoutService } from "../../../../services/layout/browser/layoutService.js";
import type { IChatService } from "../../../../services/chat/common/chatService.js";
import type { IActiveSessionThread, IChat, ISession, IUntitledChatSession, ThreadId } from "../../../../../sessions/services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../../../../sessions/services/sessions/common/sessionsManagementService.js";
import { ChatPane } from "../pane/chatPane.js";
import { ChatTitleControl } from "./chatTitleControl.js";
import { h } from "../../../../../base/browser/dom.js";
import type { IChatContextPickService, ChatContextAttachment } from "../../../../services/chat/common/chatContextService.js";
import type { IQuickInputService } from "../../../../../platform/quickinput/common/quickInput.js";
import { ContextKeyService, type IContextKey, type IContextKeyService } from "../../../../../platform/contextkey/common/contextkey.js";
import { ChatSessionInspectorVisibleContext } from "../../common/chat.js";
import { SessionInspector } from "./sessionInspector.js";

let chatViewInstanceId = 0;
let chatPaneInstanceId = 0;

interface ChatPaneEntry {
	readonly tabId: string;
	readonly label: string;
	readonly pane: ChatPane;
}

/**
 * Chat tab container.
 *
 * Each untitled or active durable Session owns one retained ChatPane. Thread
 * selection remains internal to durable panes, while untitled sessions
 * materialize only when their first message is sent.
 */
export class ChatViewPane extends ViewPane {
	private readonly chatService: IChatService;
	private readonly sessionService: ISessionsManagementService;
	private readonly contextMenuService: IContextMenuService;
	private readonly commandService: ICommandService;
	private readonly titleControl: ChatTitleControl;
	private readonly paneHost: HTMLDivElement;
	private readonly body: HTMLDivElement;
	private readonly inspector: SessionInspector;
	private readonly inspectorVisible: IContextKey<boolean>;
	private readonly empty: HTMLDivElement;
	private readonly panes = new Map<string, ChatPane>();
	private readonly tabOrder: string[] = [];
	private activePane: ChatPane | undefined;
	private initialUntitledSessionId: string | undefined;
	private viewDisposed = false;
	private focusReturn: (() => void) | undefined;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		chatService: IChatService,
		sessionService: ISessionsManagementService,
		menuService: IMenuService,
		contextMenuService: IContextMenuService,
		private readonly contextViewService: IContextViewService,
		commandService: ICommandService,
		private readonly layoutService: IWorkbenchLayoutService,
		private readonly contextPickService: IChatContextPickService,
		private readonly quickInputService: IQuickInputService,
		contextKeyService?: IContextKeyService,
	) {
		super(container, options);
		this.chatService = chatService;
		this.sessionService = sessionService;
		this.contextMenuService = contextMenuService;
		this.commandService = commandService;
		this.element.classList.add("ash-chat-view-pane");
		this.headerElement.hidden = true;
		this.contentElement.classList.add("ash-chat-view");
		const viewId = `ash-chat-view-${++chatViewInstanceId}`;
		this.titleControl = this._register(new ChatTitleControl(
			this.element,
			viewId,
			{
				selectTab: (tabId) => this.selectTab(tabId),
				closeTab: (tabId) => this.closeTab(tabId),
				moveTab: (sourceTabId, targetTabId, position) => this.moveTab(sourceTabId, targetTabId, position),
			},
			menuService,
			contextMenuService,
		));
		this.paneHost = h(container.ownerDocument, "div");
		this.paneHost.className = "ash-chat-pane-host";
		this.empty = h(container.ownerDocument, "div");
		this.empty.className = "ash-chat-empty ash-chat-view-empty";
		this.empty.textContent = "Start a new chat to begin.";
		this.body = h(container.ownerDocument, "div");
		this.body.className = "ash-chat-body";
		this.body.append(this.paneHost);
		const inspectorContextKeys = contextKeyService ?? this._register(new ContextKeyService());
		this.inspectorVisible = ChatSessionInspectorVisibleContext.bindTo(inspectorContextKeys);
		this._register(toDisposable(() => this.inspectorVisible.reset()));
		this.inspector = this._register(new SessionInspector(this.body, sessionService, {
			close: () => this.setInspectorVisible(false),
		}));
		this.inspector.element.hidden = true;
		this.contentElement.append(this.body);
		this.body.addEventListener("keydown", (event) => {
			if (event.key !== "Escape" || !this.inspectorVisible.get()) return;
			event.preventDefault();
			this.setInspectorVisible(false);
		});
		const ResizeObserver = container.ownerDocument.defaultView?.ResizeObserver;
		if (ResizeObserver) {
			const observer = new ResizeObserver(() => this.updateResponsiveLayout());
			observer.observe(this.body);
			this._register(toDisposable(() => observer.disconnect()));
		}
		this._register(sessionService.onDidChange(() => this.syncSessions()));
		this._register(layoutService.onDidChangePartVisibility((event) => {
			if (event.partId === "auxiliarybar" && event.visible) this.ensureTabForVisibleChat();
		}));
		this._register(toDisposable(() => {
			this.viewDisposed = true;
			for (const pane of this.panes.values()) pane.dispose();
			this.panes.clear();
		}));
		this.syncSessions();
		this.updateResponsiveLayout();
		this.ensureTabForVisibleChat();
		void sessionService.initialize().then(() => {
			if (this.viewDisposed) return;
			this.discardInitialUntitledSessionWhenDurableChatExists();
			this.ensureTabForVisibleChat();
		});
	}

	override focus(): void {
		this.activePane?.focus();
	}

	toggleInspector(): void {
		this.setInspectorVisible(!this.inspectorVisible.get());
	}

	addContext(attachment: ChatContextAttachment): void {
		this.ensureTabForVisibleChat();
		this.activePane?.addContext(attachment);
	}

	acceptInput(value?: string): Promise<void> {
		this.ensureTabForVisibleChat();
		return this.activePane?.acceptInput(value) ?? Promise.resolve();
	}

	override get partTitleProjection(): PartTitleProjection {
		return this.titleControl.partTitleProjection;
	}

	private syncSessions(): void {
		this.rekeyMaterializedPanes();
		const entries: ChatPaneEntry[] = [];
		const retainedPaneIds = new Set<string>();
		for (const untitledSession of this.sessionService.untitledSessions) {
			const paneId = untitledSessionPaneId(untitledSession);
			retainedPaneIds.add(paneId);
			let pane = this.panes.get(paneId);
			if (!pane) {
				pane = new ChatPane(
					this.paneHost,
					`ash-chat-pane-${++chatPaneInstanceId}`,
					this.chatService,
					{ kind: "untitled", session: untitledSession },
					this.sessionService,
					this.contextMenuService,
					this.contextViewService,
					this.commandService,
					this.contextPickService,
					this.quickInputService,
				);
				setDisposableOwner(pane, this);
				this.panes.set(paneId, pane);
			} else {
				pane.selectUntitledSession(untitledSession);
			}
			entries.push({ tabId: pane.element.id, label: untitledSession.title.trim() || "New Chat", pane });
		}
		for (const session of this.sessionService.sessions) {
			if (session.status !== "active") continue;
			const selection = this.selectionForSession(session);
			if (!selection) continue;
			const paneId = sessionPaneId(session);
			retainedPaneIds.add(paneId);
			let pane = this.panes.get(paneId);
			if (!pane) {
				pane = new ChatPane(
					this.paneHost,
					`ash-chat-pane-${++chatPaneInstanceId}`,
					this.chatService,
					{ kind: "session", active: selection },
					this.sessionService,
					this.contextMenuService,
					this.contextViewService,
					this.commandService,
					this.contextPickService,
					this.quickInputService,
				);
				setDisposableOwner(pane, this);
				this.panes.set(paneId, pane);
			} else {
				void pane.selectThread(selection);
			}
			entries.push({ tabId: pane.element.id, label: session.title.trim() || "Chat", pane });
		}
		for (const [paneId, pane] of this.panes) {
			if (retainedPaneIds.has(paneId)) continue;
			this.panes.delete(paneId);
			pane.dispose();
		}
		const activePaneId = this.activePaneId();
		const activePane = activePaneId ? this.panes.get(activePaneId) : undefined;
		const orderedEntries = this.orderEntries(entries, activePane);
		this.paneHost.replaceChildren(...orderedEntries.map((entry) => entry.pane.element), this.empty);
		this.activePane = activePane;
		this.inspector.bind(this.activePane?.model);
		for (const entry of orderedEntries) entry.pane.setVisible(entry.pane === this.activePane);
		this.empty.hidden = orderedEntries.length > 0;
		const activeTabId = this.activePane?.element.id;
		const tabIds = this.titleControl.setTabs(
			orderedEntries.map((entry) => ({ id: entry.tabId, label: entry.label, panelId: entry.pane.element.id })),
			activeTabId,
		);
		for (const entry of orderedEntries) entry.pane.setTabId(tabIds.get(entry.tabId));
	}

	private selectionForSession(session: ISession): IActiveSessionThread | undefined {
		const active = this.sessionService.active;
		if (
			active?.session.sessionId === session.sessionId &&
			isActiveThread(session, active.threadId)
		) {
			return { session, threadId: active.threadId };
		}
		const retainedThreadId = this.panes.get(sessionPaneId(session))?.threadId;
		if (retainedThreadId && isActiveThread(session, retainedThreadId)) {
			return { session, threadId: retainedThreadId };
		}
		const thread = rootThread(session) ?? session.chats.find((candidate) => candidate.status === "active");
		return thread ? { session, threadId: thread.threadId } : undefined;
	}

	private selectTab(tabId: string): void {
		const pane = this.paneForTabId(tabId);
		if (!pane) return;
		const untitledSessionId = pane.untitledSessionId;
		if (untitledSessionId) {
			this.sessionService.selectUntitledSession(untitledSessionId);
			return;
		}
		const sessionId = pane.sessionId;
		const threadId = pane.threadId;
		if (sessionId && threadId) this.sessionService.selectThread(sessionId, threadId);
	}

	private closeTab(tabId: string): void {
		const pane = this.paneForTabId(tabId);
		if (!pane) return;
		const untitledSessionId = pane.untitledSessionId;
		if (untitledSessionId) {
			this.sessionService.discardUntitledSession(untitledSessionId);
			this.hideChatWhenEmpty();
			return;
		}
		const sessionId = pane.sessionId;
		if (!sessionId) return;
		void this.sessionService.stopSession(sessionId).then(() => this.hideChatWhenEmpty()).catch(() => {});
	}

	private moveTab(sourceTabId: string, targetTabId: string | undefined, position: "before" | "after"): void {
		if (sourceTabId === targetTabId) return;
		const sourceIndex = this.tabOrder.indexOf(sourceTabId);
		if (sourceIndex < 0) return;
		this.tabOrder.splice(sourceIndex, 1);
		const targetIndex = targetTabId === undefined
			? this.tabOrder.length
			: this.tabOrder.indexOf(targetTabId);
		const insertionIndex = targetIndex < 0
			? this.tabOrder.length
			: position === "before" ? targetIndex : targetIndex + 1;
		this.tabOrder.splice(insertionIndex, 0, sourceTabId);
		this.syncSessions();
	}

	private orderEntries(entries: readonly ChatPaneEntry[], activePane: ChatPane | undefined): readonly ChatPaneEntry[] {
		const entriesByTabId = new Map(entries.map((entry) => [entry.tabId, entry]));
		const orderedTabIds = this.tabOrder.filter((tabId) => entriesByTabId.has(tabId));
		for (const entry of entries) {
			if (orderedTabIds.includes(entry.tabId)) continue;
			if (entry.pane === activePane) orderedTabIds.unshift(entry.tabId);
			else orderedTabIds.push(entry.tabId);
		}
		this.tabOrder.splice(0, this.tabOrder.length, ...orderedTabIds);
		return orderedTabIds.map((tabId) => entriesByTabId.get(tabId)!);
	}

	private ensureTabForVisibleChat(): void {
		if (!this.layoutService.isPartVisible("auxiliarybar") || this.panes.size > 0) return;
		const session = this.sessionService.createUntitledSession();
		if (this.sessionService.state === "loading" && this.initialUntitledSessionId === undefined) {
			this.initialUntitledSessionId = session.untitledSessionId;
		}
	}

	private discardInitialUntitledSessionWhenDurableChatExists(): void {
		const untitledSessionId = this.initialUntitledSessionId;
		this.initialUntitledSessionId = undefined;
		if (!untitledSessionId || !this.panes.has(`untitled:${untitledSessionId}`)) return;
		if ([...this.panes.keys()].some((paneId) => paneId.startsWith("session:"))) {
			this.sessionService.discardUntitledSession(untitledSessionId);
		}
	}

	private hideChatWhenEmpty(): void {
		if (this.panes.size === 0) this.layoutService.hidePart("auxiliarybar");
	}

	private activePaneId(): string | undefined {
		const untitledSession = this.sessionService.activeUntitledSession;
		if (untitledSession) return untitledSessionPaneId(untitledSession);
		const active = this.sessionService.active;
		return active ? sessionPaneId(active.session) : undefined;
	}

	private rekeyMaterializedPanes(): void {
		for (const [paneId, pane] of [...this.panes]) {
			const sessionId = pane.sessionId;
			if (!sessionId) continue;
			const materializedPaneId = sessionPaneIdFromId(sessionId);
			if (paneId === materializedPaneId) continue;
			const existing = this.panes.get(materializedPaneId);
			if (existing && existing !== pane) {
				pane.dispose();
				this.panes.delete(paneId);
				continue;
			}
			this.panes.delete(paneId);
			this.panes.set(materializedPaneId, pane);
		}
	}

	private paneForTabId(tabId: string): ChatPane | undefined {
		return [...this.panes.values()].find((pane) => pane.element.id === tabId);
	}

	private setInspectorVisible(visible: boolean): void {
		if (visible === this.inspectorVisible.get()) return;
		if (visible) {
			const active = this.contentElement.ownerDocument.activeElement;
			const HTMLElement = this.contentElement.ownerDocument.defaultView?.HTMLElement;
			this.focusReturn = this.titleControl.captureFocus() ?? (HTMLElement && active instanceof HTMLElement ? () => active.focus() : undefined);
		}
		this.inspectorVisible.set(visible);
		this.body.classList.toggle("inspector-visible", visible);
		this.inspector.element.hidden = !visible;
		if (visible) this.inspector.focus();
		else {
			this.focusReturn?.();
			this.focusReturn = undefined;
		}
	}

	private updateResponsiveLayout(): void {
		this.body.classList.toggle("compact", this.body.getBoundingClientRect().width < 720);
	}

}

function isActiveThread(session: ISession, threadId: ThreadId): boolean {
	return session.chats.some((thread) => thread.threadId === threadId && thread.status === "active");
}

function rootThread(session: ISession): IChat | undefined {
	return session.chats.find((thread) => thread.status === "active" && thread.origin.type === "root");
}

function untitledSessionPaneId(session: IUntitledChatSession): string {
	return `untitled:${session.untitledSessionId}`;
}

function sessionPaneId(session: ISession): string {
	return sessionPaneIdFromId(session.sessionId);
}

function sessionPaneIdFromId(sessionId: string): string {
	return `session:${sessionId}`;
}
