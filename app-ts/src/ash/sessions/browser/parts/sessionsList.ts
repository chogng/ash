import "./media/sessionsControls.css";
import "./media/sessionsList.css";
import { addDisposableListener, h } from "../../../base/browser/dom.js";
import { AbstractDisposable, Disposable, DisposableMap, toDisposable } from "../../../base/common/lifecycle.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";

/** Session picker owned by the dedicated Sessions Workbench sidebar. */
export class SessionsList extends Disposable {
	readonly domNode: HTMLElement;
	private readonly heading: HTMLHeadingElement;
	private readonly newSessionButton: HTMLButtonElement;
	private readonly list: HTMLDivElement;
	private readonly items = this._register(new DisposableMap<string, SessionListItem>());
	private readonly empty: HTMLParagraphElement;
	private readonly sessionService: ISessionsManagementService;
	private readonly viewService: ISessionsService;

	constructor(container: HTMLElement, sessionService: ISessionsManagementService, viewService: ISessionsService, title: string, newSessionLabel: string) {
		super();
		const ownerDocument = container.ownerDocument;
		this.sessionService = sessionService;
		this.viewService = viewService;
		this.domNode = h(ownerDocument, "section");
		this.domNode.className = "ash-sessions-list";
		this.heading = h(ownerDocument, "h2");
		this.heading.textContent = title;
		this.newSessionButton = h(ownerDocument, "button");
		this.newSessionButton.type = "button";
		this.newSessionButton.className = "ash-sessions-button ash-sessions-primary-button";
		this.newSessionButton.textContent = newSessionLabel;
		this.list = h(ownerDocument, "div");
		this.list.className = "ash-sessions-list-items";
		this.empty = h(ownerDocument, "p");
		this.empty.className = "ash-sessions-empty";
		this.domNode.append(this.heading, this.newSessionButton, this.list);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.newSessionButton, "click", () => viewService.openNewSession(newSessionLabel)));
		this._register(viewService.onDidChange(() => this.render()));
		this.render();
	}

	focus(): void {
		const firstItem = this.list.querySelector<HTMLButtonElement>("button");
		if (firstItem) firstItem.focus();
		else this.newSessionButton.focus();
	}

	private render(): void {
		const ownerDocument = this.domNode.ownerDocument;
		const ordered: SessionListItem[] = [];
		const present = new Set<string>();
		const activeSelection = this.viewService.activeSelection;
		for (const session of this.sessionService.untitledSessions) {
			const selected = activeSelection?.kind === "untitled" && activeSelection.session.untitledSessionId === session.untitledSessionId;
			const key = `untitled:${session.untitledSessionId}`;
			const item = this.items.get(key) ?? this.items.set(key, new SessionListItem(ownerDocument));
			item.update(session.title || "New Session", selected, () => this.viewService.openUntitledSession(session.untitledSessionId));
			ordered.push(item);
			present.add(key);
		}
		for (const session of this.sessionService.sessions) {
			const current = activeSelection?.kind === "session" && activeSelection.active.session.sessionId === session.sessionId ? activeSelection.active : undefined;
			const thread = current
				? session.chats.find(candidate => candidate.threadId === current.threadId && candidate.status === "active")
				: session.chats.find(candidate => candidate.status === "active" && candidate.origin.type === "root") ?? session.chats.find(candidate => candidate.status === "active");
			if (!thread || session.status !== "active") continue;
			const key = `session:${session.sessionId}`;
			const item = this.items.get(key) ?? this.items.set(key, new SessionListItem(ownerDocument));
			item.update(session.title || "Untitled Session", current !== undefined, () => this.viewService.openSession(session.sessionId, thread.threadId));
			ordered.push(item);
			present.add(key);
		}
		for (const key of this.items.keys()) {
			if (!present.has(key)) this.items.deleteAndDispose(key);
		}
		if (ordered.length === 0) {
			this.empty.textContent = this.sessionService.state === "loading"
				? "Loading sessions…"
				: this.sessionService.error ?? "Create a session to begin.";
			if (this.list.firstChild !== this.empty) this.list.replaceChildren(this.empty);
			return;
		}
		for (let index = 0; index < ordered.length; index++) {
			const button = ordered[index].domNode;
			if (this.list.childNodes[index] !== button) this.list.insertBefore(button, this.list.childNodes[index] ?? null);
		}
		while (this.list.childNodes.length > ordered.length) this.list.removeChild(this.list.lastChild!);
	}
}

class SessionListItem extends AbstractDisposable {
	readonly domNode: HTMLButtonElement;
	private open: () => void = () => {};
	private readonly clickListener;

	constructor(ownerDocument: Document) {
		super();
		this.domNode = h(ownerDocument, "button");
		this.domNode.type = "button";
		this.domNode.className = "ash-sessions-list-item";
		this.clickListener = addDisposableListener(this.domNode, "click", () => this.open());
	}

	update(title: string, selected: boolean, open: () => void): void {
		if (this.domNode.textContent !== title) this.domNode.textContent = title;
		this.domNode.classList.toggle("selected", selected);
		this.domNode.setAttribute("aria-current", selected ? "page" : "false");
		this.open = open;
	}

	protected override disposeCore(): void {
		this.clickListener.dispose();
		this.domNode.remove();
	}
}
