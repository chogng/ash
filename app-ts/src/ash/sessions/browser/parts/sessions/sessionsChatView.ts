import type { ChatContextAttachment } from '../../../../workbench/services/chat/common/chatContextService.js';
import "./media/sessionsChatView.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import type { IDimension } from "../../../../base/browser/dom.js";
import type { IPositionedRectangle } from "../../../../base/browser/geometry.js";
import type { IView } from "../../../../base/browser/ui/grid/grid.js";
import { Disposable, setDisposableOwner, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import type { ChatMode } from "../../../../workbench/services/chat/common/chatService.js";
import type { SessionId, IActiveSessionThread, IUntitledChatSession } from "../../../services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../../services/sessions/common/sessionsManagement.js";
import type { SessionsViewSelection } from "../../../services/sessions/browser/sessionsService.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import { localize } from '../../../../nls.js';

import { SessionGridLayout, type ISessionGridEntry } from './sessionGridLayout.js';

let sessionsChatPaneInstanceId = 0;

export interface ISessionsConversationPane extends IDisposable {
	readonly element: HTMLElement;
	readonly sessionId: SessionId | undefined;
	readonly model: {
		readonly inputState: { readonly mode: ChatMode; };
		selectThread(active: IActiveSessionThread): Promise<void>;
		selectUntitledSession(session: IUntitledChatSession): void;
	};
	focus(): void;
	addContext(attachment: ChatContextAttachment): void;
	appendToDraft(text: string): void;
	captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined>;
	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void;
	setTabId(tabId: string | undefined): void;
	setVisible(visible: boolean): void;
}

export interface SessionsChatViewOptions {
	readonly sessionService: ISessionsManagementService;
	readonly createPane: (container: HTMLElement, panelId: string, selection: SessionsViewSelection) => ISessionsConversationPane;
	readonly activateSelection: (selection: SessionsViewSelection) => void;
	readonly closeSelection: (selection: SessionsViewSelection) => void;
}

/** Owns the resizable grid of retained Chat panes in the Sessions Part. */
export class SessionsChatView extends Disposable {
	readonly domNode: HTMLElement;
	private readonly grid: SessionGridLayout;
	private readonly empty: SessionsChatEmptyView;
	private readonly entries = new Map<string, SessionsChatGridEntry>();
	private activePane: ISessionsConversationPane | undefined;
	private dimension: IDimension | undefined;
	private visible = true;

	private readonly sessionService: ISessionsManagementService;
	private readonly createPane: SessionsChatViewOptions['createPane'];
	private readonly activateSelection: (selection: SessionsViewSelection) => void;
	private readonly closeSelection: (selection: SessionsViewSelection) => void;

	constructor(container: HTMLElement, options: SessionsChatViewOptions, @IInstantiationService private readonly services: IInstantiationService) {
		super();
		const ownerDocument = container.ownerDocument;
		this.sessionService = options.sessionService;
		this.createPane = options.createPane;
		this.activateSelection = options.activateSelection;
		this.closeSelection = options.closeSelection;
		this.domNode = h(ownerDocument, "section");
		this.domNode.className = "ash-sessions-chat-view";
		container.append(this.domNode);
		this.empty = new SessionsChatEmptyView(this.domNode);
		this.grid = this._register(services.createInstance(SessionGridLayout, this.domNode, this.empty));
		this._register(toDisposable(() => {
			for (const entry of this.entries.values()) entry.dispose();
			this.entries.clear();
			this.domNode.remove();
		}));
	}

	focus(): void {
		this.activePane?.focus();
	}

	addContext(attachment: ChatContextAttachment): void {
		if (!this.activePane) { throw new Error(localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.')); }
		this.activePane.addContext(attachment);
	}

	appendToDraft(text: string): void {
		if (!this.activePane) throw new Error(localize('sessions.handoff.noActiveChat', 'Agents Window has no active chat for the draft.'));
		this.activePane.appendToDraft(text);
	}

	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
		return this.activePane?.captureDraft() ?? Promise.resolve(undefined);
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.domNode.classList.toggle('hidden', !visible);
		this.grid.setVisible(visible);
		for (const entry of this.entries.values()) entry.pane.setVisible(visible);
	}

	async captureDrafts(): Promise<ReadonlyMap<string, NonNullable<IOpenAgentsWindowOptions['draft']>>> {
		return new Map(await Promise.all([...this.entries].map(async ([key, entry]) => [key, (await entry.pane.captureDraft())?.draft ?? { mode: entry.pane.model.inputState.mode, text: '', contexts: [] }] as const)));
	}

	async restoreDrafts(drafts: ReadonlyMap<string, NonNullable<IOpenAgentsWindowOptions['draft']>>): Promise<void> {
		// Both UIs retain their live models; only unsent content moves when the product entry changes.
		for (const [key, entry] of this.entries) {
			const previous = await entry.pane.captureDraft();
			previous?.clear();
			const draft = drafts.get(key);
			if (draft) { entry.pane.restoreDraft(draft); }
		}
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
					sessionService: this.sessionService,
					createPane: this.createPane,
					activateSelection: this.activateSelection,
					closeSelection: this.closeSelection,
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

	layout(_bounds: IPositionedRectangle): void { }

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
	readonly pane: ISessionsConversationPane;
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
		this.pane = this._register(options.createPane(this.element, `ash-sessions-conversation-pane-${sessionsChatPaneInstanceId}`, options.selection));
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

	layout(_bounds: IPositionedRectangle): void { }

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
