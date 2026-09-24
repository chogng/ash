import { MarkdownElement } from "../../../../../base/browser/markdownRenderer.js";
import { addDisposableListener, h } from "../../../../../base/browser/dom.js";
import { ScrollableElement } from "../../../../../base/browser/ui/scrollbar/scrollableElement.js";
import { Disposable, DisposableMap, DisposableStore } from "../../../../../base/common/lifecycle.js";
import type { ChatTurnErrorAction, IChatListItem } from "./chatListItems.js";

interface ChatListWidgetOptions {
	readonly onDidRequestMemoryReference?: (reference: string) => void;
	readonly onDidRequestErrorAction?: (action: ChatTurnErrorAction) => void;
}

class RenderedItem extends Disposable {
	constructor(public readonly item: IChatListItem, public readonly element: HTMLElement, disposables: DisposableStore) {
		super();
		this._register(disposables);
	}
}

interface ReadingAnchor {
	readonly id: string;
	readonly viewportTop: number;
}

/** Renders the ordered user, Agent, reasoning, and tool items in one Chat pane. */
export class ChatListWidget extends Disposable {
	readonly element: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private readonly transcript: HTMLDivElement;
	private readonly renderedItems = this._register(new DisposableMap<string, RenderedItem>());
	private readonly onDidRequestErrorAction: ((action: ChatTurnErrorAction) => void) | undefined;
	private readonly onDidRequestMemoryReference: ((reference: string) => void) | undefined;
	private readonly advisorExpansion = new Map<string, boolean>();
	private visible = false;
	private shouldFollow = true;

	constructor(container: HTMLElement, options: ChatListWidgetOptions = {}) {
		super();
		this.onDidRequestErrorAction = options.onDidRequestErrorAction;
		this.onDidRequestMemoryReference = options.onDidRequestMemoryReference;
		this.scrollable = this._register(new ScrollableElement(container, {
			direction: "vertical",
			vertical: "auto",
			tabIndex: -1,
		}));
		this.element = this.scrollable.element;
		this.element.classList.add("ash-chat-list-widget", "ash-chat-transcript-scrollable");
		this.transcript = this.scrollable.contentElement;
		this.transcript.classList.add("ash-chat-transcript");
		this.transcript.setAttribute("role", "log");
		this.transcript.setAttribute("aria-label", "Chat transcript");
		this.transcript.setAttribute("aria-live", "polite");
	}

	render(items: readonly IChatListItem[]): void {
		if (this.visible) this.captureFollowState();
		const anchor = this.visible && !this.shouldFollow ? this.readingAnchor() : undefined;
		const ids = new Set(items.map(item => item.id));
		for (const [id, row] of this.renderedItems) {
			if (ids.has(id)) continue;
			row.element.remove();
			this.renderedItems.deleteAndDispose(id);
		}
		let next: ChildNode | null = this.transcript.firstChild;
		for (const item of items) {
			let row = this.renderedItems.get(item.id);
			if (!row || !sameItem(row.item, item)) {
				if (row?.element === next) next = row.element.nextSibling;
				row?.element.remove();
				row = this.renderedItems.set(item.id, this.renderItem(item));
			}
			if (row.element !== next) this.transcript.insertBefore(row.element, next);
			next = row.element.nextSibling;
		}
		for (const id of this.advisorExpansion.keys()) if (!ids.has(id)) this.advisorExpansion.delete(id);
		if (this.visible) this.layout(anchor);
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		if (!visible) this.captureFollowState();
		this.visible = visible;
		if (visible) this.layout();
	}

	private captureFollowState(): void {
		this.scrollable.layout();
		const state = this.scrollable.state;
		this.shouldFollow = state.scrollHeight - state.top - state.height < 48;
	}

	private layout(anchor?: ReadingAnchor): void {
		this.scrollable.layout();
		if (this.shouldFollow) {
			this.scrollable.scrollTo(0, this.scrollable.state.maximumTop);
		} else if (anchor) {
			const row = this.renderedItems.get(anchor.id);
			if (row) {
				const contentTop = row.element.getBoundingClientRect().top - this.transcript.getBoundingClientRect().top;
				this.scrollable.scrollTo(0, contentTop - anchor.viewportTop);
			}
		}
	}

	private readingAnchor(): ReadingAnchor | undefined {
		const viewport = this.scrollable.scrollableElement.getBoundingClientRect();
		for (const element of this.transcript.children) {
			const rect = element.getBoundingClientRect();
			if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
				return { id: (element as HTMLElement).dataset.itemId!, viewportTop: rect.top - viewport.top };
			}
		}
		return undefined;
	}

	private renderItem(item: IChatListItem): RenderedItem {
		const disposables = new DisposableStore();
		const article = h(this.element.ownerDocument, "article");
		article.className = `ash-chat-item ash-chat-item-${item.type}`;
		article.dataset.itemId = item.id;
		if (item.transient) article.dataset.transient = "true";
		if (item.isError) article.classList.add("error");
		const label = h(this.element.ownerDocument, item.type === "advisor" ? "summary" : "div");
		label.className = "ash-chat-item-label";
		label.textContent = itemLabel(item);
		const body = item.type === "advisor" ? h(this.element.ownerDocument, "details") : article;
		body.append(label);
		if (body !== article) {
			const disclosure = body as HTMLDetailsElement;
			disclosure.open = this.advisorExpansion.get(item.id) ?? true;
			disposables.add(addDisposableListener(disclosure, "toggle", () => { this.advisorExpansion.set(item.id, disclosure.open); }));
			article.append(body);
		}
		if (item.type === "agentMessage" || item.type === "reasoning" || item.type === "plan" || item.type === "advisor") {
			const markdown = disposables.add(new MarkdownElement({
				ownerDocument: this.element.ownerDocument,
				markdown: item.text,
				breaks: true,
			}));
			body.append(markdown.element);
		} else {
			const content = h(this.element.ownerDocument, "pre");
			content.textContent = item.text;
			body.append(content);
		}
		if (this.onDidRequestMemoryReference) {
			const references = [...new Set(item.text.match(/memory:[A-Za-z0-9_-]+/g) ?? [])].filter(reference => reference.length <= 4096).slice(0, 8);
			for (const [index, reference] of references.entries()) {
				const button = h(this.element.ownerDocument, 'button');
				button.type = 'button';
				button.textContent = `Open memory reference ${index + 1}`;
				article.append(button);
				disposables.add(addDisposableListener(button, 'click', () => this.onDidRequestMemoryReference?.(reference)));
			}
		}
		if (item.detail) {
			const detail = h(this.element.ownerDocument, "p");
			detail.className = "ash-chat-turn-error-detail";
			detail.textContent = item.detail;
			body.append(detail);
		}
		if (item.action) {
			const action = item.action;
			const button = h(this.element.ownerDocument, "button");
			button.type = "button";
			button.className = "ash-chat-turn-error-action";
			button.textContent = action.label;
			article.append(button);
			disposables.add(addDisposableListener(button, "click", () => this.onDidRequestErrorAction?.(action)));
		}
		return new RenderedItem(item, article, disposables);
	}
}

function sameItem(left: IChatListItem, right: IChatListItem): boolean {
	return left.id === right.id && left.type === right.type && left.text === right.text
		&& left.transient === right.transient && left.isError === right.isError
		&& left.label === right.label && left.detail === right.detail && left.errorCode === right.errorCode
		&& sameAction(left.action, right.action);
}

function sameAction(left: ChatTurnErrorAction | undefined, right: ChatTurnErrorAction | undefined): boolean {
	if (left === right) return true;
	if (!left || !right || left.type !== right.type || left.label !== right.label) return false;
	return left.type !== "retry" || (right.type === "retry" && left.turnId === right.turnId);
}

function itemLabel(item: IChatListItem): string {
	if (item.label) return item.label;
	switch (item.type) {
		case "userMessage":
		case "userContext":
		case "userImage":
		case "userImageAttachment":
		case "userAudioAttachment":
			return "You";
		case "agentMessage":
			return "Ash";
		case "reasoning":
			return "Reasoning";
		case "plan":
			return "Plan";
		case "toolCall":
			return "Tool call";
		case "toolResult":
			return item.isError ? "Tool error" : "Tool result";
		case "advisor":
			return "Advisor";
		case "turnError":
			return "Error";
	}
}
