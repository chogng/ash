import { ChatAttachmentsContentPart } from './chatContentParts/chatAttachmentsContentPart.js';
import './media/chatListWidget.css';
import { addDisposableListener, h } from "../../../../../base/browser/dom.js";
import { ScrollableElement } from "../../../../../base/browser/ui/scrollbar/scrollableElement.js";
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from "../../../../../base/common/lifecycle.js";
import type { URI } from '../../../../../base/common/uri.js';
import type { ChatTurnErrorAction, IChatListItem } from "./chatListItems.js";
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatMarkdownContentPart } from './chatContentParts/chatMarkdownContentPart.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { BareFontInfo, EDITOR_FONT_DEFAULTS } from '../../../../../editor/common/config/fontInfo.js';
import { CodeEditorConfiguration } from '../../../codeEditor/common/editorConfiguration.js';
import { ChatEditorConfiguration } from '../../common/constants.js';
import { DomWidget } from '../../../../../platform/domWidget/browser/domWidget.js';
import { ChatToolInvocationPart } from './chatContentParts/toolInvocationParts/chatToolInvocationPart.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { localize } from '../../../../../nls.js';
import { ChatHookContentPart } from './chatContentParts/chatHookContentPart.js';

interface ChatListWidgetOptions {
	readonly onDidRequestMemoryReference?: (reference: string) => void;
	readonly onDidRequestErrorAction?: (action: ChatTurnErrorAction) => void;
	readonly onDidRequestLink?: (target: string) => void;
	readonly imageResourceLoader?: (resource: URI) => Promise<Blob>;
}

class RenderedItem extends Disposable {
	constructor(public item: IChatListItem, public readonly element: HTMLElement, disposables: DisposableStore, public readonly toolPart?: ChatToolInvocationPart, public readonly markdownPart?: ChatMarkdownContentPart) {
		super();
		this._register(disposables);
	}
}

interface ReadingAnchor {
	readonly id: string;
	readonly viewportTop: number;
}

interface ChatListViewState {
	readonly visible: boolean;
	readonly shouldFollow: boolean;
	readonly top: number;
	readonly anchor: ReadingAnchor | undefined;
	readonly advisorExpansion: readonly [string, boolean][];
	readonly toolExpansion?: readonly [string, boolean][];
	readonly focus: { readonly itemId: string; readonly index: number; } | undefined;
}

/** Renders the ordered user, Agent, reasoning, and tool items in one Chat pane. */
export class ChatListWidget extends DomWidget {
	private readonly domNode: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private readonly transcript: HTMLDivElement;
	private readonly renderedItems = this._register(new DisposableMap<string, RenderedItem>());
	private readonly onDidRequestErrorAction: ((action: ChatTurnErrorAction) => void) | undefined;
	private readonly onDidRequestMemoryReference: ((reference: string) => void) | undefined;
	private readonly onDidRequestLink: ((target: string) => void) | undefined;
	private readonly imageResourceLoader: ChatListWidgetOptions['imageResourceLoader'];
	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	private readonly advisorExpansion = new Map<string, boolean>();
	private visible = false;
	private shouldFollow = true;
	private pendingReadingPosition: { readonly top: number; readonly anchor: ReadingAnchor | undefined; } | undefined;

	public get element(): HTMLElement { return this.domNode; }

	constructor(container: HTMLElement, options: ChatListWidgetOptions, @IInstantiationService private readonly instantiationService: IInstantiationService, @IConfigurationService private readonly configurationService: IConfigurationService) {
		super();
		this.onDidRequestErrorAction = options.onDidRequestErrorAction;
		this.onDidRequestMemoryReference = options.onDidRequestMemoryReference;
		this.onDidRequestLink = options.onDidRequestLink;
		this.imageResourceLoader = options.imageResourceLoader;
		this.scrollable = this._register(new ScrollableElement(container, {
			direction: "vertical",
			vertical: "auto",
			tabIndex: -1,
		}));
		this.domNode = this.scrollable.element;
		this.element.classList.add("ash-chat-list-widget", "ash-chat-transcript-scrollable");
		this.transcript = this.scrollable.contentElement;
		this.transcript.classList.add("ash-chat-transcript");
		this.transcript.setAttribute("role", "log");
		this.transcript.setAttribute('aria-label', localize('chat.transcript.label', 'Chat transcript'));
		this.transcript.setAttribute("aria-live", "polite");
		const accessibilityId = createUuid();
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 100, name: `chatTranscript-${type}-${accessibilityId}`,
				getProvider: () => {
					const active = this.element.ownerDocument.activeElement as HTMLElement | null;
					if (!active || !this.transcript.contains(active)) return undefined;
					const provider = new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type }, () => {
						if (type === AccessibleViewType.Help) return localize('chat.transcript.help', 'Chat responses\nUse Tab and Shift+Tab to reach response links, code block actions and tool summaries. Press Enter or Space on a tool summary to expand or collapse its input, source, execution target, output and result. Streaming updates keep focus and expansion. Failed calls show an error; a finished turn without a result is never shown as successful. Use <keybinding:editor.action.accessibleView> to read the transcript as plain text, including collapsed tool details. Closing this view returns focus to the response.');
						return [...this.renderedItems].map(([, row]) => row.toolPart
							? [...row.toolPart.domNode.children].map(child => child.textContent).filter(Boolean).join('\n\n')
							: [itemLabel(row.item), row.item.text, row.item.detail].filter(Boolean).join('\n\n')).join('\n\n');
					}, () => { if (active.isConnected) active.focus(); }, AccessibilityVerbositySettingId.Chat);
					provider.onDidChangeContent = this._onDidChangeContent.event;
					return provider;
				},
			}));
		}
		this.updateCodeBlockOptions();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			const keys = [...Object.values(ChatEditorConfiguration), CodeEditorConfiguration.fontFamily, CodeEditorConfiguration.fontSize, CodeEditorConfiguration.lineHeight];
			if (!keys.some(key => event.affectsConfiguration(key))) return;
			if (this.visible) this.captureFollowState();
			const anchor = this.visible && !this.shouldFollow ? this.readingAnchor() : undefined;
			this.updateCodeBlockOptions();
			if (this.visible) this.layout(anchor);
		}));
	}

	private updateCodeBlockOptions(): void {
		const family = this.configurationService.getValue<string>(ChatEditorConfiguration.fontFamily) || this.configurationService.getValue<string>(CodeEditorConfiguration.fontFamily) || EDITOR_FONT_DEFAULTS.fontFamily;
		const size = this.configurationService.getValue<number>(ChatEditorConfiguration.fontSize) || this.configurationService.getValue<number>(CodeEditorConfiguration.fontSize);
		const height = this.configurationService.getValue<number>(ChatEditorConfiguration.lineHeight) || this.configurationService.getValue<number>(CodeEditorConfiguration.lineHeight);
		const font = BareFontInfo._create(family, 'normal', size, 'normal', 'normal', height, 0, 1, true);
		// Inherited CSS values update existing Markdown nodes without replacing selections or link handlers.
		this.transcript.style.setProperty('--ash-chat-code-font-family', font.getMassagedFontFamily());
		this.transcript.style.setProperty('--ash-chat-code-font-size', `${font.fontSize}px`);
		this.transcript.style.setProperty('--ash-chat-code-line-height', `${font.lineHeight}px`);
		this.element.classList.toggle('code-word-wrap', this.configurationService.getValue<string>(ChatEditorConfiguration.wordWrap) === 'on');
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
			if (row?.toolPart && item.toolInvocation && row.toolPart.toolCallId === item.toolInvocation.call.toolCallId) {
				row.toolPart.render(item.toolInvocation, item.attachmentSource);
				row.item = item;
				row.element.classList.toggle('error', item.isError === true);
				if (item.transient) row.element.dataset.transient = 'true';
				else delete row.element.dataset.transient;
			} else if (row?.markdownPart && !sameItem(row.item, item) && row.item.type === item.type && row.item.label === item.label && row.item.detail === item.detail && sameAction(row.item.action, item.action)
				&& row.markdownPart.tryIncrementalUpdate({ value: item.text, supportThemeIcons: true, supportAlertSyntax: true }, item.transient)) {
				row.item = item;
				row.element.classList.toggle('error', item.isError === true);
				if (item.transient) row.element.dataset.transient = 'true';
				else delete row.element.dataset.transient;
			} else if (!row || !sameItem(row.item, item)) {
				if (row?.element === next) next = row.element.nextSibling;
				row?.element.remove();
				row = this.renderedItems.set(item.id, this.renderItem(item));
			}
			if (row.element !== next) this.transcript.insertBefore(row.element, next);
			next = row.element.nextSibling;
		}
		for (const id of this.advisorExpansion.keys()) if (!ids.has(id)) this.advisorExpansion.delete(id);
		if (this.visible) this.layout(anchor);
		this._onDidChangeContent.fire();
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		if (!visible) {
			this.captureFollowState();
			this.pendingReadingPosition = { top: this.scrollable.state.top, anchor: this.shouldFollow ? undefined : this.readingAnchor() };
		}
		this.visible = visible;
		if (visible) {
			if (this.pendingReadingPosition) {
				this.scrollable.layout();
				this.scrollable.scrollTo(0, this.pendingReadingPosition.top);
			}
			this.layout(this.pendingReadingPosition?.anchor);
			this.pendingReadingPosition = undefined;
		}
	}

	/** Captures presentation state without taking ownership of conversation data. */
	public getViewState(): ChatListViewState {
		if (this.visible) this.captureFollowState();
		const active = this.element.ownerDocument.activeElement;
		let focus: ChatListViewState['focus'];
		for (const [itemId, row] of this.renderedItems) {
			const index = [...row.element.querySelectorAll('button, a, summary')].indexOf(active!);
			if (index >= 0) { focus = { itemId, index }; break; }
		}
		return {
			visible: this.visible,
			shouldFollow: this.shouldFollow,
			top: this.pendingReadingPosition?.top ?? this.scrollable.state.top,
			anchor: this.pendingReadingPosition?.anchor ?? (this.visible && !this.shouldFollow ? this.readingAnchor() : undefined),
			advisorExpansion: [...this.advisorExpansion],
			toolExpansion: [...this.renderedItems].flatMap(([id, row]) => row.toolPart ? [[id, row.toolPart.domNode.open] as [string, boolean]] : []),
			focus,
		};
	}

	/** Re-renders from the model, then restores reading position after the host mounts the new root. */
	public restoreViewState(state: ChatListViewState, items: readonly IChatListItem[]): void {
		for (const [id, expanded] of state.advisorExpansion) this.advisorExpansion.set(id, expanded);
		this.render(items);
		for (const [id, expanded] of state.toolExpansion ?? []) {
			const part = this.renderedItems.get(id)?.toolPart;
			if (part) part.domNode.open = expanded;
		}
		this.shouldFollow = state.shouldFollow;
		// Hidden panes cannot measure their scroll range until their retained host is shown again.
		this.pendingReadingPosition = { top: state.top, anchor: state.anchor };
		this.setVisible(state.visible);
		if (state.focus) {
			const row = this.renderedItems.get(state.focus.itemId);
			row?.element.querySelectorAll<HTMLElement>('button, a, summary')[state.focus.index]?.focus({ preventScroll: true });
		}
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
		if (item.toolInvocation) {
			const part = disposables.add(this.instantiationService.createInstance(ChatToolInvocationPart, article.ownerDocument, item.toolInvocation, item.attachmentSource));
			disposables.add(part.onDidChangeHeight(() => { if (this.visible) this.layout(); this._onDidChangeContent.fire(); }));
			article.append(part.domNode);
			return new RenderedItem(item, article, disposables, part);
		}
		if (item.type === 'hook' && item.hookPart) {
			const part = disposables.add(new ChatHookContentPart(article.ownerDocument, item.hookPart));
			article.append(part.domNode);
			return new RenderedItem(item, article, disposables);
		}
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
		let markdownPart: ChatMarkdownContentPart | undefined;
		if (item.type === "agentMessage" || item.type === "reasoning" || item.type === "plan" || item.type === "advisor") {
			const markdown = disposables.add(this.instantiationService.createInstance(ChatMarkdownContentPart, {
				ownerDocument: this.element.ownerDocument,
				markdown: { value: item.text, supportThemeIcons: true, supportAlertSyntax: true },
				breaks: true,
				fillInIncompleteTokens: item.transient,
				linkHandler: (target: string) => this.onDidRequestLink?.(target),
				imageResourceLoader: this.imageResourceLoader,
			}));
			markdownPart = markdown;
			body.append(markdown.domNode);
		} else {
			const content = h(this.element.ownerDocument, "pre");
			content.textContent = item.text;
			body.append(content);
		}
		if (item.content?.some(part => part.type !== 'text')) {
			const media = disposables.add(this.instantiationService.createInstance(ChatAttachmentsContentPart, { ownerDocument: article.ownerDocument, variables: item.content, source: item.attachmentSource }));
			disposables.add(media.onDidChangeHeight(() => { if (this.visible) this.layout(); this._onDidChangeContent.fire(); }));
			body.append(media.domNode);
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
		return new RenderedItem(item, article, disposables, undefined, markdownPart);
	}
}

function sameItem(left: IChatListItem, right: IChatListItem): boolean {
	return left.id === right.id && left.type === right.type && left.text === right.text
		&& left.transient === right.transient && left.isError === right.isError
		&& left.label === right.label && left.detail === right.detail && left.errorCode === right.errorCode
		&& sameContent(left.content, right.content) && left.attachmentSource?.sessionId === right.attachmentSource?.sessionId
		&& left.attachmentSource?.threadId === right.attachmentSource?.threadId
		&& left.attachmentSource?.itemId === right.attachmentSource?.itemId
		&& left.attachmentSource?.kind === right.attachmentSource?.kind
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
		case 'hook': return 'Hook';
		case "userMessage":
		case "userContext":
		case "userImage":
		case "userImageAttachment":
		case "userAudioAttachment":
			return localize('chat.transcript.you', 'You');
		case "agentMessage":
			return "Ash";
		case "reasoning":
			return localize('chat.transcript.reasoning', 'Reasoning');
		case "plan":
			return localize('chat.transcript.plan', 'Plan');
		case "toolCall":
			return localize('chat.transcript.toolCall', 'Tool call');
		case "toolResult":
			return item.isError ? localize('chat.transcript.toolError', 'Tool error') : localize('chat.transcript.toolResult', 'Tool result');
		case "advisor":
			return "Advisor";
		case "turnError":
			return localize('chat.transcript.error', 'Error');
	}
}


function sameContent(left: IChatListItem['content'], right: IChatListItem['content']): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((part, index) => {
		const next = right[index];
		if (part.type !== next.type) return false;
		if (part.type === 'text') return next.type === 'text' && part.text === next.text;
		if ('url' in part) return 'url' in next && part.url === next.url;
		return 'attachment' in next && part.attachment.contentDigest === next.attachment.contentDigest;
	});
}
