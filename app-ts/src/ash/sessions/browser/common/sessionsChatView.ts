import "../../../workbench/contrib/chat/browser/media/chat.css";
import "./sessionsChatView.css";
import { addDisposableListener, h } from "../../../base/browser/dom.js";
import type { IDimension } from "../../../base/browser/dom.js";
import type { IPositionedRectangle } from "../../../base/browser/geometry.js";
import { Direction, Grid, Sizing, type IView } from "../../../base/browser/ui/grid/grid.js";
import { Disposable, setDisposableOwner, toDisposable } from "../../../base/common/lifecycle.js";
import type { ICommandService } from "../../../platform/commands/common/commands.js";
import type { IContextMenuService } from "../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import type { IQuickInputService } from "../../../platform/quickinput/common/quickInput.js";
import { ChatPane } from "../../../workbench/contrib/chat/browser/pane/chatPane.js";
import type { IChatContextPickService } from "../../../workbench/services/chat/common/chatContextService.js";
import type { IChatService } from "../../../workbench/services/chat/common/chatService.js";
import type { SessionId } from "../../services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagementService.js";
import type { SessionsViewSelection } from "../../services/view/common/sessionsService.js";

let sessionsChatPaneInstanceId = 0;

export interface SessionsChatViewOptions {
	readonly chatService: IChatService;
	readonly sessionService: ISessionsManagementService;
	readonly contextMenuService: IContextMenuService;
	readonly contextViewService: IContextViewService;
	readonly commandService: ICommandService;
	readonly contextPickService: IChatContextPickService;
	readonly quickInputService: IQuickInputService;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
	readonly closeSelection: (selection: SessionsViewSelection) => void;
}

/** Owns the resizable grid of retained Chat panes in the Sessions Part. */
export class SessionsChatView extends Disposable {
	readonly domNode: HTMLElement;
	private readonly grid: Grid<SessionsChatGridView>;
	private readonly empty: SessionsChatEmptyView;
	private readonly entries = new Map<string, SessionsChatGridEntry>();
	private activePane: ChatPane | undefined;
	private dimension: IDimension | undefined;

	private readonly chatService: IChatService;
	private readonly sessionService: ISessionsManagementService;
	private readonly contextMenuService: IContextMenuService;
	private readonly contextViewService: IContextViewService;
	private readonly commandService: ICommandService;
	private readonly contextPickService: IChatContextPickService;
	private readonly quickInputService: IQuickInputService;
	private readonly activateSelection: (selection: SessionsViewSelection) => void;
	private readonly closeSelection: (selection: SessionsViewSelection) => void;

	constructor(container: HTMLElement, options: SessionsChatViewOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		this.chatService = options.chatService;
		this.sessionService = options.sessionService;
		this.contextMenuService = options.contextMenuService;
		this.contextViewService = options.contextViewService;
		this.commandService = options.commandService;
		this.contextPickService = options.contextPickService;
		this.quickInputService = options.quickInputService;
		this.activateSelection = options.activateSelection;
		this.closeSelection = options.closeSelection;
		this.domNode = h(ownerDocument, "section");
		this.domNode.className = "ash-sessions-chat-view";
		container.append(this.domNode);
		this.empty = new SessionsChatEmptyView(this.domNode);
		this.grid = this._register(new Grid<SessionsChatGridView>(this.domNode, { type: "leaf", view: this.empty, size: 800 }, { sashPresentation: { type: "inset", gap: 8 } }));
		this.grid.element.classList.add("ash-sessions-chat-grid");
		this._register(toDisposable(() => {
			for (const entry of this.entries.values()) entry.dispose();
			this.entries.clear();
			this.domNode.remove();
		}));
	}

	focus(): void {
		this.activePane?.focus();
	}

	layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.grid.layout(dimension.width, dimension.height);
	}

	updateVisibleSelections(selections: readonly SessionsViewSelection[], active: SessionsViewSelection | undefined): void {
		this.rekeyMaterializedEntries();
		this.empty.update(this.sessionService.state, this.sessionService.error);
		const visibleKeys = new Set(selections.map(selectionKey));
		for (const [key, entry] of [...this.entries]) {
			if (visibleKeys.has(key)) continue;
			this.grid.removeView(entry);
			this.entries.delete(key);
			entry.dispose();
		}
		let reference: SessionsChatGridView = this.empty;
		for (const selection of selections) {
			const key = selectionKey(selection);
			let entry = this.entries.get(key);
			if (!entry) {
				entry = new SessionsChatGridEntry(this.domNode, {
					selection,
					chatService: this.chatService,
					sessionService: this.sessionService,
					contextMenuService: this.contextMenuService,
					contextViewService: this.contextViewService,
					commandService: this.commandService,
					contextPickService: this.contextPickService,
					quickInputService: this.quickInputService,
					activateSelection: this.activateSelection,
					closeSelection: this.closeSelection,
				});
				setDisposableOwner(entry, this);
				this.entries.set(key, entry);
				this.grid.addView(entry, Sizing.Distribute, reference, Direction.Right);
			}
			entry.update(selection, sameSelection(selection, active));
			reference = entry;
		}
		this.grid.setViewVisible(this.empty, selections.length === 0);
		this.activePane = active ? this.entries.get(selectionKey(active))?.pane : undefined;
		if (this.dimension) this.grid.layout(this.dimension.width, this.dimension.height);
	}

	private rekeyMaterializedEntries(): void {
		for (const [key, entry] of [...this.entries]) {
			const sessionId = entry.pane.sessionId;
			if (!sessionId) continue;
			const durableKey = sessionKey(sessionId);
			if (key === durableKey) continue;
			const existing = this.entries.get(durableKey);
			if (existing && existing !== entry) {
				this.grid.removeView(entry);
				this.entries.delete(key);
				entry.dispose();
				continue;
			}
			this.entries.delete(key);
			this.entries.set(durableKey, entry);
		}
	}
}

type SessionsChatGridView = SessionsChatEmptyView | SessionsChatGridEntry;

class SessionsChatEmptyView implements IView {
	readonly element: HTMLDivElement;
	readonly minimumWidth = 0;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 0;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	private readonly heading: HTMLHeadingElement;
	private readonly description: HTMLParagraphElement;

	constructor(container: HTMLElement) {
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-sessions-chat-view-empty";
		this.heading = h(ownerDocument, "h2");
		this.description = h(ownerDocument, "p");
		this.element.append(this.heading, this.description);
		container.append(this.element);
		this.update("ready", undefined);
	}

	layout(_bounds: IPositionedRectangle): void {}

	update(state: ISessionsManagementService["state"], error: string | undefined): void {
		if (state === "loading") {
			this.heading.textContent = "Loading sessions";
			this.description.textContent = "Restoring your agent workspace…";
		} else if (error) {
			this.heading.textContent = "Sessions unavailable";
			this.description.textContent = error;
		} else {
			this.heading.textContent = "Start a code session";
			this.description.textContent = "Create a session to plan, implement, or review work with the coding agent.";
		}
	}
}

interface SessionsChatGridEntryOptions extends SessionsChatViewOptions {
	readonly selection: SessionsViewSelection;
}

class SessionsChatGridEntry extends Disposable implements IView {
	readonly element: HTMLElement;
	readonly pane: ChatPane;
	readonly minimumWidth = 300;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 240;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	private readonly title: HTMLSpanElement;
	private selection: SessionsViewSelection;

	constructor(container: HTMLElement, options: SessionsChatGridEntryOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		this.selection = options.selection;
		this.element = h(ownerDocument, "article");
		this.element.className = "ash-sessions-chat-slot";
		const header = h(ownerDocument, "div");
		header.className = "ash-sessions-chat-slot-header";
		const activate = h(ownerDocument, "button");
		activate.type = "button";
		activate.className = "ash-sessions-chat-slot-title";
		this.title = h(ownerDocument, "span");
		this.title.id = `ash-sessions-chat-slot-title-${++sessionsChatPaneInstanceId}`;
		activate.append(this.title);
		const close = h(ownerDocument, "button");
		close.type = "button";
		close.className = "ash-sessions-chat-slot-close";
		close.setAttribute("aria-label", "Close visible session");
		close.textContent = "×";
		header.append(activate, close);
		this.pane = this._register(new ChatPane(
			this.element,
			`ash-sessions-chat-pane-${sessionsChatPaneInstanceId}`,
			options.chatService,
			options.selection.kind === "session" ? { kind: "session", active: options.selection.active } : { kind: "untitled", session: options.selection.session },
			options.sessionService,
			options.contextMenuService,
			options.contextViewService,
			options.commandService,
			options.contextPickService,
			options.quickInputService,
		));
		this.pane.setTabId(this.title.id);
		this.pane.setVisible(true);
		this.element.append(header, this.pane.element);
		this._register(addDisposableListener(activate, "click", () => this.pane.focus()));
		this._register(addDisposableListener(close, "click", event => {
			event.stopPropagation();
			options.closeSelection(this.selection);
		}));
		this._register(addDisposableListener(this.element, "focusin", () => {
			if (!this.element.classList.contains("active")) options.activateSelection(this.selection);
		}));
		this._register(addDisposableListener(this.element, "pointerdown", event => {
			if (close.contains(event.target as Node)) return;
			if (!this.element.classList.contains("active")) options.activateSelection(this.selection);
		}));
		this._register(toDisposable(() => this.element.remove()));
	}

	layout(_bounds: IPositionedRectangle): void {}

	update(selection: SessionsViewSelection, active: boolean): void {
		this.selection = selection;
		this.element.classList.toggle("active", active);
		this.element.setAttribute("aria-current", active ? "true" : "false");
		if (selection.kind === "session") {
			this.title.textContent = selection.active.session.title.trim() || "Agent session";
			void this.pane.selectThread(selection.active).catch(error => console.error("Failed to select Sessions Chat thread", error));
		} else {
			this.title.textContent = selection.session.title.trim() || "New code session";
			this.pane.selectUntitledSession(selection.session);
		}
	}
}

function sameSelection(left: SessionsViewSelection | undefined, right: SessionsViewSelection | undefined): boolean {
	return left !== undefined && right !== undefined && selectionKey(left) === selectionKey(right);
}

function selectionKey(selection: SessionsViewSelection): string {
	return selection.kind === "session" ? sessionKey(selection.active.session.sessionId) : `untitled:${selection.session.untitledSessionId}`;
}

function sessionKey(sessionId: SessionId): string {
	return `session:${sessionId}`;
}
