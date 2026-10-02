import "./media/sessionsChatView.css";
import { addDisposableListener, h } from "../../../base/browser/dom.js";
import type { IDimension } from "../../../base/browser/dom.js";
import type { IPositionedRectangle } from "../../../base/browser/geometry.js";
import type { IView } from "../../../base/browser/ui/grid/grid.js";
import { Disposable, setDisposableOwner, toDisposable } from "../../../base/common/lifecycle.js";
import type { ICommandService } from "../../../platform/commands/common/commands.js";
import type { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import type { IContextMenuService } from "../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import { ChatWidget } from "../../../workbench/contrib/chat/browser/widget/chatWidget.js";
import { ChatWidgetModel } from '../chatWidgetModel.js';
import type { ChatInputDelegate } from '../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import type { IChatInputPart } from '../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { IChatService } from "../../../workbench/services/chat/common/chatService.js";
import type { SessionId } from "../../services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { SessionsViewSelection, SessionsPage } from "../../services/sessions/browser/sessionsService.js";
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { INotificationService } from '../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../platform/native/common/nativeHost.js';
import { localize } from '../../../nls.js';

import { SessionGridLayout, type ISessionGridEntry } from './sessionGridLayout.js';

let sessionsChatPaneInstanceId = 0;

export interface SessionsChatViewOptions {
	readonly page: SessionsPage;
	readonly chatService: IChatService;
	readonly sessionService: ISessionsManagementService;
	readonly contextMenuService: IContextMenuService;
	readonly contextViewService: IContextViewService;
	readonly accessibleViewService: IAccessibleViewService;
	readonly notifications: INotificationService;
	readonly commandService: ICommandService;
	readonly createInputPart: (container: HTMLElement, delegate: ChatInputDelegate, model: ChatWidgetModel) => IChatInputPart;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
	readonly closeSelection: (selection: SessionsViewSelection) => void;
	readonly createNewSession: () => void;
}

/** Owns the resizable grid of retained Chat panes in the Sessions Part. */
export class SessionsChatView extends Disposable {
	readonly domNode: HTMLElement;
	private readonly grid: SessionGridLayout;
	private readonly empty: SessionsChatEmptyView;
	private readonly entries = new Map<string, SessionsChatGridEntry>();
	private activePane: ChatWidget<ChatWidgetModel> | undefined;
	private dimension: IDimension | undefined;
	private visible = true;

	private readonly chatService: IChatService;
	private readonly sessionService: ISessionsManagementService;
	private readonly contextMenuService: IContextMenuService;
	private readonly contextViewService: IContextViewService;
	private readonly accessibleViewService: IAccessibleViewService;
	private readonly notifications: INotificationService;
	private readonly commandService: ICommandService;
	private readonly createInputPart: SessionsChatViewOptions['createInputPart'];
	private readonly activateSelection: (selection: SessionsViewSelection) => void;
	private readonly closeSelection: (selection: SessionsViewSelection) => void;
	private readonly createNewSession: () => void;

	constructor(container: HTMLElement, options: SessionsChatViewOptions, @IInstantiationService private readonly services: IInstantiationService) {
		super();
		const ownerDocument = container.ownerDocument;
		this.chatService = options.chatService;
		this.sessionService = options.sessionService;
		this.contextMenuService = options.contextMenuService;
		this.contextViewService = options.contextViewService;
		this.accessibleViewService = options.accessibleViewService;
		this.notifications = options.notifications;
		this.commandService = options.commandService;
		this.createInputPart = options.createInputPart;
		this.activateSelection = options.activateSelection;
		this.closeSelection = options.closeSelection;
		this.createNewSession = options.createNewSession;
		this.domNode = h(ownerDocument, "section");
		this.domNode.className = "ash-sessions-chat-view";
		container.append(this.domNode);
		this.empty = new SessionsChatEmptyView(this.domNode);
		this.grid = this._register(services.createInstance(SessionGridLayout, this.domNode, this.empty, options.page));
		this._register(toDisposable(() => {
			for (const entry of this.entries.values()) entry.dispose();
			this.entries.clear();
			this.domNode.remove();
		}));
	}

	focus(): void {
		this.activePane?.focus();
	}

	appendToDraft(text: string): void {
		if (!this.activePane) throw new Error(localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'));
		this.activePane.appendToDraft(text);
	}

	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void } | undefined> {
		return this.activePane?.captureDraft() ?? Promise.resolve(undefined);
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		for (const entry of this.entries.values()) entry.pane.setVisible(visible);
	}

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void {
		if (!this.activePane) throw new Error(localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'));
		this.activePane.restoreDraft(draft);
		if (this.visible) this.activePane.focus();
	}

	layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.grid.layout(dimension.width, dimension.height);
	}

	updateVisibleSelections(selections: readonly SessionsViewSelection[], active: SessionsViewSelection | undefined): void {
		this.rekeyMaterializedEntries();
		this.domNode.classList.toggle('single-chat', selections.length === 1);
		this.empty.update(this.sessionService.state, this.sessionService.error);
		const removed: SessionsChatGridEntry[] = [];
		const visibleKeys = new Set(selections.map(selectionKey));
		for (const [key, entry] of [...this.entries]) {
			if (visibleKeys.has(key)) continue;
			this.entries.delete(key);
			removed.push(entry);
		}
		const gridEntries: ISessionGridEntry[] = [];
		for (const selection of selections) {
			const key = selectionKey(selection);
			let entry = this.entries.get(key);
			if (!entry) {
				entry = this.services.createInstance(SessionsChatGridEntry, this.domNode, {
					selection,
					chatService: this.chatService,
					sessionService: this.sessionService,
					contextMenuService: this.contextMenuService,
					contextViewService: this.contextViewService,
					accessibleViewService: this.accessibleViewService,
					notifications: this.notifications,
					commandService: this.commandService,
					createInputPart: this.createInputPart,
					activateSelection: this.activateSelection,
					closeSelection: this.closeSelection,
					createNewSession: this.createNewSession,
				});
				setDisposableOwner(entry, this);
				this.entries.set(key, entry);
				entry.pane.setVisible(this.visible);
			}
			entry.update(selection, sameSelection(selection, active));
			entry.element.classList.toggle('last-slot', selection === selections.at(-1));
			gridEntries.push({ id: key, view: entry });
		}
		if (gridEntries.length === 0) {
			gridEntries.push({ id: 'empty', view: this.empty });
		}
		this.grid.reconcile(gridEntries, active ? selectionKey(active) : 'empty');
		for (const entry of removed) {
			entry.dispose();
		}
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
				continue;
			}
			this.entries.delete(key);
			this.entries.set(durableKey, entry);
		}
	}
}

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

interface SessionsChatGridEntryOptions extends Omit<SessionsChatViewOptions, 'page'> {
	readonly selection: SessionsViewSelection;
}

class SessionsChatGridEntry extends Disposable implements IView {
	readonly element: HTMLElement;
	readonly pane: ChatWidget<ChatWidgetModel>;
	readonly minimumWidth = 300;
	readonly maximumWidth = Number.POSITIVE_INFINITY;
	readonly minimumHeight = 240;
	readonly maximumHeight = Number.POSITIVE_INFINITY;
	private readonly title: HTMLSpanElement;
	private selection: SessionsViewSelection;

	constructor(container: HTMLElement, options: SessionsChatGridEntryOptions, @IInstantiationService services: IInstantiationService) {
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
		const model = new ChatWidgetModel(options.chatService, options.selection.kind === "session" ? { kind: "session", active: options.selection.active } : { kind: "untitled", session: options.selection.session }, options.sessionService);
		this.pane = this._register(services.createInstance<ChatWidget<ChatWidgetModel>>(ChatWidget,
			this.element,
			`ash-sessions-chat-pane-${sessionsChatPaneInstanceId}`,
			model,
			options.createNewSession,
			options.contextMenuService,
			options.contextViewService,
			options.commandService,
			options.accessibleViewService,
			options.notifications,
			undefined,
			undefined,
			undefined,
			(container: HTMLElement, delegate: ChatInputDelegate) => options.createInputPart(container, delegate, model),
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
			void this.pane.model.selectThread(selection.active).catch(error => console.error("Failed to select Sessions Chat thread", error));
		} else {
			this.title.textContent = selection.session.title.trim() || "New code session";
			this.pane.model.selectUntitledSession(selection.session);
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
