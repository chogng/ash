import { findLast } from '../../../../../base/common/arraysFind.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { ICommandService, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { HasSpeechProvider, TextToSpeechInProgress } from '../../../speech/common/speechService.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ChatResourceGroupWidget } from './chatContentParts/chatResourceGroupWidget.js';
import { ChatAttachmentsContentPart } from './chatContentParts/chatAttachmentsContentPart.js';
import './media/chatListWidget.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { ChatTurnErrorAction, IChatListItem } from './chatListItems.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { OPEN_SESSION_LINK_SCHEME } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { ChatMarkdownContentPart } from './chatContentParts/chatMarkdownContentPart.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { BareFontInfo, EDITOR_FONT_DEFAULTS } from '../../../../../editor/common/config/fontInfo.js';
import { CodeEditorConfiguration } from '../../../codeEditor/common/editorConfiguration.js';
import { ChatEditorConfiguration } from '../../common/constants.js';
import { DomWidget } from '../../../../../platform/domWidget/browser/domWidget.js';
import { ChatToolInvocationPart } from './chatContentParts/toolInvocationParts/chatToolInvocationPart.js';
import type { IChatMcpAppDelegate } from './chatContentParts/toolInvocationParts/chatMcpAppSubPart.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { localize } from '../../../../../nls.js';
import { ChatAccessibilityProvider } from '../accessibility/chatAccessibilityProvider.js';
import { ChatResponseAccessibleView } from '../accessibility/chatResponseAccessibleView.js';
import { ChatHookContentPart } from './chatContentParts/chatHookContentPart.js';
import { ChatFindWidget, computeRevealScrollTop, type IChatFindHost } from './chatFind/chatFindWidget.js';

interface ChatListWidgetOptions {
	readonly onDidChangeFindVisibility?: (visible: boolean) => void;
	readonly getHistoryState?: () => { readonly loading: boolean; readonly error?: string; } | undefined;
	readonly loadOlderHistory?: () => Promise<void>;
	/** The host owns its transcript layout; content parts keep their shared styles. */
	readonly classPrefix?: string;
	readonly mcpAppDelegate?: IChatMcpAppDelegate;
	readonly onDidRequestMemoryReference?: (reference: string) => void;
	readonly onDidRequestErrorAction?: (action: ChatTurnErrorAction) => void;
	readonly onDidRequestLink?: (target: string) => void;
	readonly imageResourceLoader?: (resource: URI) => Promise<Blob>;
}

const textInputSelector = 'textarea, [role="textbox"], [contenteditable="true"]';
const focusableSelector = 'button, a, summary, textarea, audio, [role="textbox"], [tabindex="0"], [contenteditable="true"]';
const speechContextKeys = new Set([HasSpeechProvider.key, TextToSpeechInProgress.key]);
const viewportMargin = 600;

class RenderedItem extends Disposable {
	inViewport = true;
	readonly edit = this._register(new MutableDisposable<DisposableStore>());
	public editButton: Button | undefined;
	public copyButton: Button | undefined;
	public updateReadAloud: (() => void) | undefined;
	public readonly reading = this._register(new MutableDisposable<IDisposable & { readonly source: CancellationTokenSource; readonly item: IChatListItem; }>());
	readonly memoryReferences = this._register(new DisposableMap<string, IDisposable & { readonly element: HTMLButtonElement; }>());
	readonly media = this._register(new MutableDisposable<ChatAttachmentsContentPart>());
	readonly mediaChanges = this._register(new MutableDisposable());
	readonly resources = this._register(new MutableDisposable<ChatResourceGroupWidget>());
	readonly resourceChanges = this._register(new MutableDisposable());
	constructor(
		public item: IChatListItem,
		public readonly element: HTMLElement,
		disposables: DisposableStore,
		public readonly toolPart?: ChatToolInvocationPart,
		public readonly markdownPart?: ChatMarkdownContentPart,
		public readonly attachments?: HTMLElement,
		public readonly hookPart?: ChatHookContentPart,
		public readonly context?: { readonly disclosure: HTMLDetailsElement; readonly summary: HTMLElement; readonly content: HTMLElement; },
	) {
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
	readonly lastFocusedItemId?: string;
	readonly shouldFollow: boolean;
	readonly top: number;
	readonly anchor: ReadingAnchor | undefined;
	readonly advisorExpansion: readonly [string, boolean][];
	readonly contextExpansion?: readonly [string, boolean][];
	readonly toolExpansion?: readonly [string, boolean][];
	readonly focus: { readonly itemId: string; readonly index: number; readonly textInput?: boolean; } | undefined;
}

/** Renders the ordered user, Agent, reasoning, and tool items in one Chat pane. */
export class ChatListWidget extends DomWidget {
	private readonly findWidget = this._register(new MutableDisposable<ChatFindWidget>());
	private items: readonly IChatListItem[] = [];
	private lastFocusedItemId: string | undefined;
	private readonly domNode: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private readonly transcript: HTMLDivElement;
	private readonly renderedItems = this._register(new DisposableMap<string, RenderedItem>());
	private readonly onDidRequestErrorAction: ((action: ChatTurnErrorAction) => void) | undefined;
	private readonly onDidRequestMemoryReference: ((reference: string) => void) | undefined;
	private readonly onDidRequestLink: ((target: string) => void) | undefined;
	private readonly imageResourceLoader: ChatListWidgetOptions['imageResourceLoader'];
	private readonly mcpAppDelegate: ChatListWidgetOptions['mcpAppDelegate'];
	private readonly classPrefix: string;
	private readonly accessibilityProvider = new ChatAccessibilityProvider();
	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	private readonly advisorExpansion = new Map<string, boolean>();
	private readonly contextExpansion = new Map<string, boolean>();
	private visible = true;
	private shouldFollow = true;
	private readingPosition: ReadingAnchor | undefined;
	private layingOut = false;
	private readonly relayout = this._register(new RunOnceScheduler(() => { if (this.visible) this.layout(); }, 0));
	private pendingReadingPosition: { readonly top: number; readonly anchor: ReadingAnchor | undefined; } | undefined;
	private pendingItems: readonly IChatListItem[] | undefined;
	private readonly viewportObserver: IntersectionObserver | undefined;
	private readonly pendingViewportMeasurements = new Set<string>();
	private readonly refreshViewport = this._register(new RunOnceScheduler(() => this.refreshRowViewports(), 0));

	public get element(): HTMLElement { return this.domNode; }

	public getFindController(): ChatFindWidget {
		return this.findWidget.value ??= this.instantiationService.createInstance(ChatFindWidget, {
			element: this.element,
			onDidChange: this._onDidChangeContent.event,
			getItems: () => this.items,
			getRowElement: id => this.renderedItems.get(id)?.element,
			getViewportAnchorItemId: () => this.readingAnchor()?.id,
			reveal: (id, target) => this.revealItem(id, target),
			focus: () => this.transcript.focus(),
			isVisible: () => this.visible,
			setFindVisible: visible => this.setFindVisible(visible),
			getHistoryState: this.options.getHistoryState,
			loadOlderHistory: this.options.loadOlderHistory,
		} satisfies IChatFindHost);
	}

	public focusCodeBlock(reverse = false): void {
		if (this.isDisposed || !this.visible) { return; }
		const focused = this.getFocus();
		const item = focused && focused.type !== 'userMessage' ? focused : [...this.items].reverse().find(item => item.type === 'agentMessage');
		if (!item) { return; }
		this.reveal(item);
		this.renderedItems.get(item.id)?.markdownPart?.focusCodeBlock(reverse);
	}

	public getFocus(): IChatListItem | undefined {
		return this.lastFocusedItemId ? this.renderedItems.get(this.lastFocusedItemId)?.item : undefined;
	}

	public getSibling(item: IChatListItem | undefined, type: 'next' | 'previous'): IChatListItem | undefined {
		if (!item) { return type === 'next' ? this.items[0] : this.items.at(-1); }
		const index = this.items.findIndex(candidate => candidate.id === item.id);
		return index < 0 ? undefined : this.items[index + (type === 'next' ? 1 : -1)];
	}

	public focus(item: IChatListItem): void {
		if (this.visible) { this.renderedItems.get(item.id)?.element.focus({ preventScroll: true }); }
	}

	public reveal(item: IChatListItem): void { this.revealItem(item.id); }

	public focusResponseItem(lastFocused = false): void {
		if (!this.visible) { return; }
		const item = (lastFocused ? this.getFocus() : undefined)
			?? findLast(this.items, item => item.type === 'agentMessage') ?? this.items.at(-1);
		if (item) { this.focus(item); this.reveal(item); }
		else { this.transcript.focus(); }
	}

	/** Source changes retire the query, its pending history work and borrowed render ranges together. */
	public resetFind(): void { this.findWidget.clear(); }

	constructor(
		container: HTMLElement, private readonly options: ChatListWidgetOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commands: ICommandService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
	) {
		super();
		this.onDidRequestErrorAction = options.onDidRequestErrorAction;
		this.onDidRequestMemoryReference = options.onDidRequestMemoryReference;
		this.onDidRequestLink = options.onDidRequestLink;
		this.imageResourceLoader = options.imageResourceLoader;
		this.mcpAppDelegate = options.mcpAppDelegate;
		this.classPrefix = options.classPrefix ?? 'ash-chat';
		this.scrollable = this._register(new ScrollableElement(container, {
			direction: 'vertical',
			vertical: 'auto',
			tabIndex: -1,
		}));
		this._register(this.scrollable.onDidScroll(event => {
			if (this.layingOut || !this.visible) return;
			this.shouldFollow = event.current.maximumTop - event.current.top < 48;
			this.readingPosition = this.shouldFollow ? undefined : this.readingAnchor();
		}));
		this.domNode = this.scrollable.element;
		this.element.classList.add(`${this.classPrefix}-list-widget`, `${this.classPrefix}-transcript-scrollable`);
		this.transcript = this.scrollable.contentElement;
		this.transcript.classList.add(`${this.classPrefix}-transcript`);
		this.transcript.setAttribute('role', 'log');
		this.transcript.tabIndex = -1;
		this.transcript.setAttribute('aria-label', this.accessibilityProvider.getWidgetAriaLabel());
		this.transcript.setAttribute('aria-live', 'polite');
		this._register(addDisposableListener(this.transcript, 'focusin', event => {
			const row = (event.target as HTMLElement).closest<HTMLElement>('[data-item-id]');
			const id = row?.dataset.itemId;
			if (id && this.renderedItems.get(id)?.element === row) { this.lastFocusedItemId = id; }
			this.refreshRowViewports();
		}));
		const Observer = this.element.ownerDocument.defaultView?.IntersectionObserver;
		if (Observer) {
			// Keep text, actions and disclosure DOM available to native selection, find
			// and accessibility. Only the derived code-editor documents leave memory.
			this.viewportObserver = new Observer(entries => {
				for (const entry of entries) {
					const row = this.renderedItems.get((entry.target as HTMLElement).dataset.itemId!);
					if (!row || row.element !== entry.target) continue;
					row.inViewport = entry.isIntersecting;
					this.updateRowViewport(row);
				}
				if (this.findWidget.value?.visible) { this._onDidChangeContent.fire(); }
			}, { root: this.scrollable.scrollableElement, rootMargin: `${viewportMargin}px 0px` });
			this._register(toDisposable(() => this.viewportObserver?.disconnect()));
			this._register(addDisposableListener(this.transcript, 'focusout', () => this.refreshViewport.schedule()));
			this._register(addDisposableListener(this.element.ownerDocument, 'selectionchange', () => this.refreshViewport.schedule()));
		}
		const accessibilityId = createUuid();
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 100, name: `chatTranscript-${AccessibleViewType.Help}-${accessibilityId}`,
			getProvider: () => {
				const active = this.element.ownerDocument.activeElement as HTMLElement | null;
				if (!active || !this.transcript.contains(active)) return undefined;
				const provider = new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type: AccessibleViewType.Help }, () => {
					return localize('chat.requests.help', 'Use Edit message on an accepted request to edit its text. Enter inserts a line; Ctrl or Command+Enter sends it into a new chat with its original context and attachments. Cancel edit or Escape keeps the original request and draft. Fork Conversation in the Command Palette copies the current history without sending. Use New Chat to start an empty conversation. These actions preserve the original conversation.') + '\n' + localize('chat.remainingActions.help', 'Chat: Configure Tools edits the focused draft’s tool selection; Escape discards changes. Chat: Approve Tool Once and Chat: Decline Tool act only on the currently displayed approval. They never save an approval rule. Chat: Submit Requested Answers submits the current question form with its entered values; required answers must be filled. Use Ctrl or Command+Enter while the question form has focus. Chat: Retry Failed Request repeats an available failed request through its original retry policy. Chat: Copy Final Response copies the latest completed assistant reply without speaker labels or streaming text. Chat: Next Code Block and Chat: Previous Code Block move focus through the current or latest response’s code blocks and wrap at the ends. Use Ctrl or Command+Alt+Page Down or Page Up in Chat. Chat: Export Conversation Transcript saves a frozen backend text snapshot, including voice transcripts and partial markers. Chat: Open Saved Transcript (Read-Only) opens a supported saved document in a read-only editor; it does not restore or execute a conversation. These commands keep the unsent draft.') + '\n' + localize('chat.pickers.commandHelp', 'Use Chat: Open Model Picker, Chat: Open Mode or Agent Picker, or Chat: Open Permission Picker in the Command Palette to configure the most recently focused composer. Model and mode pickers also open with {0} and {1}. Fixed-mode inputs keep the mode picker hidden. Cowork uses its existing permission flow. Escape closes a picker. Opening or cancelling keeps the draft and attachments without sending. Switching conversations retires pending selections and permission confirmations.', '<keybinding:workbench.action.chat.openModelPicker>', '<keybinding:workbench.action.chat.openModePicker>') + '\n' + localize('chat.execution.help', 'Chat: Send Message uses the current draft, attachments and submission policy. Chat: Add Message to Queue waits for the current request to finish; Chat: Steer with Message explicitly targets it. When idle, both send normally. Explicit steering rejects a different mode, Skill or task type. Queue and steering actions do not run slash commands. Failed submissions restore the draft if it has not been edited again. Use {0} to stop the focused task while keeping unsent text. Stopping remains available for running work when AI features are disabled.', '<keybinding:workbench.action.chat.cancel>') + '\n' + localize('chat.queue.manageHelp', 'Use Chat: Edit Queued Message, Chat: Remove Queued Message or Chat: Send Queued Message Immediately in the Command Palette, then select a message in queue order. Editing pauses that message and preserves attached inputs and your unsent draft. Ctrl or Command+Enter saves; Escape restores a previously pending message at its original position. Previously paused or failed messages remain paused when editing is cancelled. A changed revision requires choosing the message again. Send Immediately moves the original message to the front and stops the current task before running it. Remove All Queued Messages removes the captured revisions and keeps messages added while the action runs.') + '\n' + localize('chat.navigation.help', 'Use {0} to focus the latest response and {1} to return to the last focused message. Use {2} and {3} to move between user prompts without wrapping. Navigation includes loaded messages; load earlier messages to reach older prompts. On macOS, the input-to-list shortcut applies only on the first visual input line. Quick Chat reverses the input-to-list shortcut direction. Use {4} to focus a pending confirmation or return to the input. Focusing never accepts or declines a request, sends a message or changes the draft.', '<keybinding:chat.action.focus>', '<keybinding:workbench.chat.action.focusLastFocused>', '<keybinding:workbench.action.chat.previousUserPrompt>', '<keybinding:workbench.action.chat.nextUserPrompt>', '<keybinding:workbench.action.chat.focusConfirmation>') + '\n' + localize('chat.find.commandsHelp', 'Use {0} to find text in this conversation. Find includes complete code blocks and continues through earlier history without sending or changing the draft. Use the result controls to navigate; Escape closes Find and restores focus.', '<keybinding:workbench.action.chat.find>') + '\n' + localize('chat.commands.help', 'Use Focus Chat Input in the Command Palette to return to the most recently focused Chat input. From a conversation, use {0} to return to its input. Chat: Copy Conversation in the Command Palette or Copy All in the conversation title menu copies all text messages and voice transcripts, including earlier history. Markdown is preserved. Draft text is kept in the input.', '<keybinding:workbench.action.chat.focusInput>') + '\n' + localize('chat.naming.help', 'New conversations take an initial name from the first message. Use Chat: Rename Conversation in the Command Palette to set a name. Enter saves it and Escape cancels. Manual names are kept when automatic naming finishes later.') + '\n' + localize('chat.history.paginationHelp', 'Chat initially shows recent messages. Use Tab to reach Load earlier messages, then Enter or Space to load another page. Loading preserves your draft, active approvals and reading position. If it fails, use Retry earlier messages. Live messages remain available while older history loads.') + '\n' + localize('chat.transcript.help', 'Chat responses\nWith a Speech extension, use Read aloud on a completed response. The same button stops reading; Escape also stops it. Hiding or removing the response cancels reading. Use Stop reading aloud in the Command Palette after moving focus elsewhere. Use Tab and Shift+Tab to reach message copy actions, response links, code block actions and tool summaries. Copy message copies its current source text, including Markdown. Press Enter or Space on a tool summary to expand or collapse its input, source, execution target, output and result. Code block actions copy the complete source, insert it into the active editor, or open it in a new unsaved file. Use context summaries to inspect the exact text attached to a request. Use resource summaries to inspect returned data and Open resource for a read-only preview. Use Load image or Load audio to read a stored attachment. Open image or Open audio opens its original bytes in a read-only editor. Opening audio pauses the transcript player. Open interactive view loads a declared MCP App; use Tab or Shift+Tab to reach its controls and Close interactive view to return focus. Streaming updates and provider corrections keep code selections, keyboard focus and expansion. Reading older messages preserves the reading position; returning to the bottom follows new content. Failed calls show an error; a finished turn without a result is never shown as successful. Use <keybinding:editor.action.accessibleView> to read the transcript as plain text, including collapsed tool details. Closing this view returns focus to the response.') + '\n' + localize('chat.imageGeneration.help', 'Generated images appear outside the tool details. Use Open image for a read-only preview of the original image, or Download to save it. Progress ends with a reveal after decoding; reduced motion and high contrast show the result directly. Failure or stopping ends progress, and restored history does not replay generation animations.');
				}, () => { if (active.isConnected) active.focus(); }, AccessibilityVerbositySettingId.Chat);
				provider.onDidChangeContent = this._onDidChangeContent.event;
				return provider;
			},
		}));
		this._register(AccessibleViewRegistry.register(new ChatResponseAccessibleView({
			getItems: () => this.items,
			onDidChangeContent: this._onDidChangeContent.event,
			getFocusedElement: () => {
				const active = this.element.ownerDocument.activeElement;
				return this.visible && !this.isDisposed && active instanceof this.element.ownerDocument.defaultView!.HTMLElement && this.transcript.contains(active) ? active : undefined;
			},
		})));
		// Keep the position measured before an image, editor wrap or disclosure changes height.
		const resize = new ResizeObserver(() => this.relayout.schedule());
		resize.observe(this.transcript);
		resize.observe(this.element);
		this._register(toDisposable(() => resize.disconnect()));
		this.updateCodeBlockOptions();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			const keys = [...Object.values(ChatEditorConfiguration), CodeEditorConfiguration.fontFamily, CodeEditorConfiguration.fontSize, CodeEditorConfiguration.lineHeight];
			if (!keys.some(key => event.affectsConfiguration(key))) return;
			if (this.visible) this.captureFollowState();
			const anchor = this.visible && !this.shouldFollow ? this.readingPosition : undefined;
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
		this.items = items;
		if (!this.visible) {
			// The model continues receiving events. Hidden presentation consumes its
			// latest projection once on show instead of parsing every intermediate one.
			this.pendingItems = items;
			return;
		}
		this.reconcile(items);
	}

	private reconcile(items: readonly IChatListItem[]): void {
		if (this.visible) this.captureFollowState();
		const anchor = this.visible && !this.shouldFollow ? this.readingPosition : undefined;
		let changed = false;
		const ids = new Set(items.map(item => item.id));
		for (const [id, row] of this.renderedItems) {
			if (ids.has(id)) continue;
			this.viewportObserver?.unobserve(row.element);
			row.element.remove();
			this.renderedItems.deleteAndDispose(id);
			this.pendingViewportMeasurements.delete(id);
			changed = true;
		}
		let next: ChildNode | null = this.transcript.firstChild;
		for (const item of items) {
			let row = this.renderedItems.get(item.id);
			if (row && sameItem(row.item, item) && row.item.content === item.content && sameToolInvocation(row.item.toolInvocation, item.toolInvocation)) {
				row.item = item;
				if (row.element !== next) { this.transcript.insertBefore(row.element, next); changed = true; }
				next = row.element.nextSibling;
				continue;
			}
			changed = true;
			if (row?.context && item.type === 'userContext' && item.contextText !== undefined) {
				row.context.summary.textContent = item.text;
				row.context.content.setAttribute('aria-label', item.text);
				if (row.item.contextText !== item.contextText) row.context.content.textContent = item.contextText;
				row.item = item;
			} else if (row?.hookPart && item.hookPart && row.item.hookPart?.run.runId === item.hookPart.run.runId) {
				row.hookPart.render(item.hookPart);
				row.item = item;
				row.element.classList.toggle('error', item.isError === true);
				if (item.transient) row.element.dataset.transient = 'true';
				else delete row.element.dataset.transient;
			} else if (row?.toolPart && item.toolInvocation && row.toolPart.toolCallId === item.toolInvocation.call.toolCallId) {
				row.toolPart.render(item.toolInvocation, item.attachmentSource);
				row.item = item;
				row.element.classList.toggle('error', item.isError === true);
				if (item.transient) row.element.dataset.transient = 'true';
				else delete row.element.dataset.transient;
			} else if (row?.markdownPart && !sameItem(row.item, item) && row.item.type === item.type && row.item.label === item.label && row.item.detail === item.detail && sameAction(row.item.action, item.action)
				&& (row.item.text === item.text && row.item.transient === item.transient
					|| row.markdownPart.tryIncrementalUpdate({ value: item.text, supportThemeIcons: true, supportAlertSyntax: true }, item.transient))) {
				row.item = item;
				row.element.classList.toggle('error', item.isError === true);
				if (item.transient) row.element.dataset.transient = 'true';
				else delete row.element.dataset.transient;
			} else if (!row || !sameItem(row.item, item)) {
				if (row?.element === next) next = row.element.nextSibling;
				if (row) this.viewportObserver?.unobserve(row.element);
				row?.element.remove();
				row = this.renderedItems.set(item.id, this.renderItem(item));
				this.viewportObserver?.observe(row.element);
				if (this.viewportObserver) this.pendingViewportMeasurements.add(item.id);
			}
			if (row.copyButton) row.copyButton.enabled = row.item.text.length > 0;
			if (this.viewportObserver && row.markdownPart) this.pendingViewportMeasurements.add(item.id);
			const reading = row.reading.value;
			if (reading && (reading.item.text !== row.item.text || reading.item.attachmentSource?.sessionId !== row.item.attachmentSource?.sessionId || reading.item.attachmentSource?.threadId !== row.item.attachmentSource?.threadId)) row.reading.clear();
			row.updateReadAloud?.();
			this.renderAttachments(row);
			this.renderMemoryReferences(row);
			if (row.element !== next) this.transcript.insertBefore(row.element, next);
			next = row.element.nextSibling;
		}
		if (this.lastFocusedItemId && !ids.has(this.lastFocusedItemId)) { this.lastFocusedItemId = undefined; }
		for (const id of this.contextExpansion.keys()) if (!ids.has(id)) this.contextExpansion.delete(id);
		for (const id of this.advisorExpansion.keys()) if (!ids.has(id)) this.advisorExpansion.delete(id);
		// Reconciliation can temporarily shorten the DOM scroll range. Keep the position
		// captured before moving retained widgets instead of interpreting that clamp as user input.
		if (changed) {
			if (this.visible) this.layout(anchor, false);
			if (this.pendingViewportMeasurements.size) this.refreshRowViewports();
			this._onDidChangeContent.fire();
		}
	}

	setVisible(visible: boolean): void {
		// A replacement can already be visible and still have a reading position to restore.
		if (this.visible === visible && !(visible && this.pendingReadingPosition)) return;
		if (!visible) {
			this.relayout.cancel();
			this.refreshViewport.cancel();
			for (const [, row] of this.renderedItems) row.reading.clear();
			this.captureFollowState();
			this.pendingReadingPosition = { top: this.scrollable.state.top, anchor: this.shouldFollow ? undefined : this.readingPosition };
		}
		if (visible && this.pendingItems) {
			const items = this.pendingItems;
			this.pendingItems = undefined;
			// Reconcile while still hidden, before restoring the saved scroll anchor.
			this.reconcile(items);
		}
		this.visible = visible;
		if (!visible) { this.findWidget.value?.hide(); }
		for (const [, row] of this.renderedItems) {
			row.media.value?.setVisible(visible);
			row.toolPart?.setVisible(visible);
			row.markdownPart?.setVisible(visible);
		}
		if (visible) {
			if (this.pendingReadingPosition) {
				this.layingOut = true;
				try {
					this.scrollable.layout();
					this.scrollable.scrollTo(0, this.pendingReadingPosition.top);
				} finally { this.layingOut = false; }
			}
			this.layout(this.pendingReadingPosition?.anchor);
			this.pendingReadingPosition = undefined;
			this.refreshRowViewports();
		}
	}

	private refreshRowViewports(): void {
		if (!this.visible) return;
		const viewport = this.pendingViewportMeasurements.size ? this.scrollable.scrollableElement.getBoundingClientRect() : undefined;
		for (const [id, row] of this.renderedItems) {
			if (viewport && this.pendingViewportMeasurements.delete(id)) {
				const bounds = row.element.getBoundingClientRect();
				row.inViewport = viewport.height > 0 && bounds.bottom > viewport.top - viewportMargin && bounds.top < viewport.bottom + viewportMargin;
			}
			this.updateRowViewport(row);
		}
	}

	private setFindVisible(visible: boolean): void {
		this.options.onDidChangeFindVisibility?.(visible);
		const height = visible ? this.element.querySelector<HTMLElement>('.ash-chat-find')?.getBoundingClientRect().height ?? 0 : 0;
		const padding = visible ? `${height + 16}px` : '';
		if (this.transcript.style.paddingTop === padding) { return; }
		const anchor = this.readingAnchor();
		// The first message needs real scroll space below the floating Find controls.
		this.transcript.style.paddingTop = padding;
		if (this.visible) { this.layout(anchor, false); }
	}

	private revealItem(id: string, target?: { readonly top: number; readonly bottom: number; }): void {
		const row = this.renderedItems.get(id);
		if (!row || !this.visible) { return; }
		row.markdownPart?.setViewportVisible(true);
		this.shouldFollow = false;
		this.layingOut = true;
		try {
			this.scrollable.layout();
			const viewport = this.scrollable.scrollableElement.getBoundingClientRect();
			const overlay = this.element.querySelector<HTMLElement>('.ash-chat-find:not([hidden])')?.getBoundingClientRect().height ?? 0;
			const bounds = target ?? row.element.getBoundingClientRect();
			const top = viewport.top + overlay + 8;
			const next = computeRevealScrollTop(this.scrollable.state.top, Math.max(1, viewport.bottom - top - 8), bounds.top - top, bounds.bottom - top);
			if (next !== undefined) { this.scrollable.scrollTo(0, next); }
			this.readingPosition = this.readingAnchor();
		} finally { this.layingOut = false; }
	}

	private updateRowViewport(row: RenderedItem): void {
		if (!row.markdownPart) return;
		const document = this.element.ownerDocument;
		const selection = document.getSelection();
		// Keyboard focus and a native selection pin their response even if a user
		// scrolls it out of view; scrolling must not interrupt editing or copying.
		const pinned = row.element.contains(document.activeElement)
			|| !!selection && !selection.isCollapsed && Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)).some(range => range.intersectsNode(row.element));
		row.markdownPart.setViewportVisible(row.inViewport || pinned);
	}

	/** Captures presentation state without taking ownership of conversation data. */
	public getViewState(): ChatListViewState {
		if (this.visible) this.captureFollowState();
		const active = this.element.ownerDocument.activeElement;
		let focus: ChatListViewState['focus'];
		for (const [itemId, row] of this.renderedItems) {
			if (active === row.element) { focus = { itemId, index: -1 }; break; }
			// Editor scrollbars appear after measurement; their controls must not shift the
			// remembered input ordinal while a replacement editor is still being laid out.
			const textInput = active?.matches(textInputSelector) === true;
			const index = [...row.element.querySelectorAll(textInput ? textInputSelector : focusableSelector)].indexOf(active!);
			if (index >= 0) { focus = { itemId, index, ...(textInput ? { textInput: true } : {}) }; break; }
		}
		return {
			visible: this.visible,
			lastFocusedItemId: this.lastFocusedItemId,
			shouldFollow: this.shouldFollow,
			top: this.pendingReadingPosition?.top ?? this.scrollable.state.top,
			anchor: this.pendingReadingPosition?.anchor ?? (this.visible && !this.shouldFollow ? this.readingPosition : undefined),
			advisorExpansion: [...this.advisorExpansion],
			contextExpansion: [...this.renderedItems].filter(([, row]) => row.context).map(([id, row]) => [id, row.context!.disclosure.open]),
			toolExpansion: [...this.renderedItems].flatMap(([id, row]) => row.toolPart ? [[id, row.toolPart.domNode.querySelector<HTMLDetailsElement>('details')!.open] as [string, boolean]] : []),
			focus,
		};
	}

	/** Re-renders from the model, then restores reading position after the host mounts the new root. */
	public restoreViewState(state: ChatListViewState, items: readonly IChatListItem[]): void {
		for (const [id, expanded] of state.contextExpansion ?? []) this.contextExpansion.set(id, expanded);
		for (const [id, expanded] of state.advisorExpansion) this.advisorExpansion.set(id, expanded);
		this.render(items);
		this.lastFocusedItemId = state.lastFocusedItemId && this.renderedItems.has(state.lastFocusedItemId) ? state.lastFocusedItemId : undefined;
		for (const [id, expanded] of state.contextExpansion ?? []) {
			const context = this.renderedItems.get(id)?.context;
			if (context) context.disclosure.open = expanded;
		}
		for (const [id, expanded] of state.toolExpansion ?? []) {
			const part = this.renderedItems.get(id)?.toolPart;
			if (part) part.domNode.querySelector<HTMLDetailsElement>('details')!.open = expanded;
		}
		// Hide the replacement before installing saved state: hiding captures its current scroll.
		this.setVisible(state.visible);
		this.shouldFollow = state.shouldFollow;
		// Hidden panes cannot measure their scroll range until their retained host is shown again.
		this.pendingReadingPosition = { top: state.top, anchor: state.anchor };
		if (state.visible) this.setVisible(true);
		if (state.focus) {
			const row = this.renderedItems.get(state.focus.itemId);
			row?.markdownPart?.setViewportVisible(true);
			const selector = state.focus.textInput ? textInputSelector : focusableSelector;
			if (state.focus.index === -1) { row?.element.focus({ preventScroll: true }); }
			else { row?.element.querySelectorAll<HTMLElement>(selector)[state.focus.index]?.focus({ preventScroll: true }); }
		}
	}

	private captureFollowState(): boolean {
		// DOM scrolling can precede its scroll event. Capture it before layout consumes that
		// position, otherwise an async size measurement can mistake reading for following.
		const state = this.scrollable.state;
		const scrolled = this.scrollable.scrollableElement.scrollTop !== state.top;
		if (scrolled) {
			this.shouldFollow = state.maximumTop - this.scrollable.scrollableElement.scrollTop < 48;
			this.readingPosition = this.shouldFollow ? undefined : this.readingAnchor();
		}
		this.layingOut = true;
		try { this.scrollable.layout(); }
		finally { this.layingOut = false; }
		return scrolled;
	}

	private layout(anchor?: ReadingAnchor, captureScroll = true): void {
		if ((captureScroll && this.captureFollowState()) || !anchor) anchor = this.readingPosition;
		this.layingOut = true;
		try {
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
			this.readingPosition = this.shouldFollow ? undefined : this.readingAnchor();
		} finally { this.layingOut = false; }
	}

	private readingAnchor(): ReadingAnchor | undefined {
		const viewport = this.scrollable.scrollableElement.getBoundingClientRect();
		const children = this.transcript.children;
		// Rows are in normal document flow. Find the first possible intersection
		// without reading the geometry of the entire loaded conversation on scroll.
		let low = 0;
		let high = children.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (children[middle].getBoundingClientRect().bottom <= viewport.top) low = middle + 1;
			else high = middle;
		}
		for (let index = low; index < children.length; index++) {
			const element = children[index];
			const rect = element.getBoundingClientRect();
			if (rect.top >= viewport.bottom) break;
			if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
				return { id: (element as HTMLElement).dataset.itemId!, viewportTop: rect.top - viewport.top };
			}
		}
		return undefined;
	}

	private renderAttachments(row: RenderedItem): void {
		if (!row.attachments) return;
		const content = row.item.content ?? [];
		const changed = () => { this.relayout.schedule(); this._onDidChangeContent.fire(); };
		if (content.some(part => part.type !== 'text' && part.type !== 'artifact')) {
			if (!row.media.value) {
				const media = this.instantiationService.createInstance(ChatAttachmentsContentPart, { ownerDocument: row.element.ownerDocument, variables: content, source: row.item.attachmentSource });
				row.media.value = media;
				row.attachments.prepend(media.domNode);
				row.mediaChanges.value = media.onDidChangeHeight(changed);
			} else row.media.value.updateVariables(content, row.item.attachmentSource);
		} else { row.mediaChanges.clear(); row.media.clear(); }
		if (content.some(part => part.type === 'artifact')) {
			if (!row.resources.value) {
				const resources = this.instantiationService.createInstance(ChatResourceGroupWidget, row.element.ownerDocument);
				row.resources.value = resources;
				row.attachments.append(resources.domNode);
				row.resourceChanges.value = resources.onDidChangeHeight(changed);
			}
			row.resources.value.render(content, JSON.stringify([row.item.attachmentSource?.sessionId, row.item.attachmentSource?.threadId, row.item.id]), row.item.attachmentSource);
		} else { row.resourceChanges.clear(); row.resources.clear(); }
	}

	private renderCopyAction(row: RenderedItem, lifetime: DisposableStore): void {
		const actions = h(row.element.ownerDocument, 'div');
		actions.className = 'ash-chat-message-actions';
		const button = lifetime.add(new Button(actions, {
			...defaultButtonStyles,
			label: localize('chat.message.copy', 'Copy message'),
			icon: Lxicon.copy,
			presentation: 'quiet',
			size: 'small',
			enabled: row.item.text.length > 0,
		}));
		row.copyButton = button;
		const feedback = h(row.element.ownerDocument, 'span');
		feedback.className = 'ash-chat-message-copy-status';
		feedback.setAttribute('role', 'status');
		actions.append(feedback);
		row.element.append(actions);
		const clear = lifetime.add(new RunOnceScheduler(() => { feedback.textContent = ''; }, 2000));
		let copying = false;
		lifetime.add(button.onDidClick(() => {
			if (copying || row.isDisposed || !this.visible || !row.item.text) return;
			const item = row.item;
			const context = { type: item.type, text: item.text };
			copying = true;
			button.domNode.setAttribute('aria-busy', 'true');
			clear.cancel();
			feedback.textContent = '';
			void this.commands.executeCommand('workbench.action.chat.copyItem', context).then(() => {
				if (row.isDisposed || row.item !== item) return;
				feedback.textContent = localize('chat.message.copied', 'Message copied.');
				clear.schedule();
			}, error => {
				if (row.isDisposed || row.item !== item) return;
				feedback.textContent = localize('chat.message.copyFailed', 'Could not copy message: {0}', String(error));
			}).finally(() => { copying = false; if (!row.isDisposed) button.domNode.removeAttribute('aria-busy'); });
		}));
		if (row.item.type === 'agentMessage') this.renderReadAloudAction(row, actions, lifetime);
		if (row.item.requestSource) this.renderEditAction(row, actions, lifetime);
	}

	private renderEditAction(row: RenderedItem, actions: HTMLElement, lifetime: DisposableStore): void {
		const edit = lifetime.add(new Button(actions, {
			...defaultButtonStyles, label: localize('chat.edit.label', 'Edit message'), presentation: 'quiet', size: 'small',
		}));
		row.editButton = edit;
		lifetime.add(edit.onDidClick(() => {
			if (row.edit.value || !row.item.requestSource || !this.visible) return;
			const source = row.item.requestSource;
			const store = new DisposableStore();
			row.edit.value = store;
			const editor = h(row.element.ownerDocument, 'div');
			editor.className = 'ash-chat-request-editor';
			const input = h(editor.ownerDocument, 'textarea');
			input.setAttribute('aria-label', localize('chat.edit.input', 'Edit request'));
			input.value = row.item.text;
			input.rows = Math.min(12, Math.max(3, input.value.split('\n').length));
			const explanation = h(editor.ownerDocument, 'p');
			explanation.id = createUuid();
			input.setAttribute('aria-describedby', explanation.id);
			explanation.textContent = localize('chat.edit.description', 'Sending creates a new chat from before this request. Its context and attachments are kept; the original chat and draft stay available.');
			const controls = h(editor.ownerDocument, 'div');
			controls.className = 'ash-chat-message-actions';
			const send = store.add(new Button(controls, { ...defaultButtonStyles, label: localize('chat.edit.resend', 'Send edited request'), size: 'small' }));
			const cancel = store.add(new Button(controls, { ...defaultButtonStyles, label: localize('chat.edit.cancel', 'Cancel edit'), presentation: 'quiet', size: 'small' }));
			const feedback = h(editor.ownerDocument, 'span');
			feedback.setAttribute('role', 'status');
			controls.append(feedback);
			editor.append(input, explanation, controls);
			row.element.append(editor);
			edit.enabled = false;
			store.add(toDisposable(() => { editor.remove(); edit.enabled = true; }));
			const close = (): void => {
				const restoreFocus = this.visible && editor.contains(editor.ownerDocument.activeElement);
				row.edit.clear();
				if (restoreFocus) edit.focus();
				this.relayout.schedule();
				this._onDidChangeContent.fire();
			};
			let pending = false;
			let attempt: { text: string; commandId: string; } | undefined;
			const submit = async (): Promise<void> => {
				if (pending || !input.value.trim() || row.isDisposed || !this.visible) return;
				if (attempt?.text !== input.value) attempt = { text: input.value, commandId: createUuid() };
				pending = true;
				input.readOnly = true;
				send.enabled = cancel.enabled = false;
				editor.setAttribute('aria-busy', 'true');
				feedback.textContent = '';
				try {
					await this.commands.executeCommand('workbench.action.chat.resendRequest', { ...source, ...attempt });
					if (!row.isDisposed) close();
				} catch (error) {
					if (!row.isDisposed) feedback.textContent = localize('chat.edit.failed', 'Could not send the edited request: {0}', String(error));
				} finally {
					pending = false;
					if (!row.isDisposed && row.edit.value === store) {
						input.readOnly = false;
						send.enabled = !!input.value.trim();
						cancel.enabled = true;
						editor.removeAttribute('aria-busy');
						const active = editor.ownerDocument.activeElement;
						if (this.visible && (editor.contains(active) || active === editor.ownerDocument.body)) input.focus();
					}
				}
			};
			store.add(send.onDidClick(() => void submit()));
			store.add(cancel.onDidClick(close));
			store.add(addDisposableListener(input, 'input', () => { send.enabled = !!input.value.trim(); }));
			store.add(addDisposableListener(editor, 'keydown', event => {
				if (event.isComposing) return;
				if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); close(); }
				else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); void submit(); }
			}));
			input.focus();
			this.relayout.schedule(); this._onDidChangeContent.fire();
		}));
	}

	private renderReadAloudAction(row: RenderedItem, actions: HTMLElement, lifetime: DisposableStore): void {
		const button = lifetime.add(new Button(actions, {
			...defaultButtonStyles,
			label: localize('chat.message.readAloud', 'Read aloud'),
			presentation: 'quiet',
			size: 'small',
		}));
		const feedback = h(actions.ownerDocument, 'span');
		feedback.className = 'ash-chat-message-read-status';
		feedback.setAttribute('role', 'status');
		actions.append(feedback);
		const update = () => {
			if (row.isDisposed) return;
			const context = this.contextKeys.getContext();
			button.domNode.hidden = !CommandsRegistry.hasCommand('workbench.action.chat.readChatResponseAloud') || context.getValue(HasSpeechProvider.key) !== true;
			const reading = !!row.reading.value;
			button.label = reading ? localize('chat.message.stopReadAloud', 'Stop reading aloud') : localize('chat.message.readAloud', 'Read aloud');
			button.enabled = reading || !row.item.transient && !!row.item.text && context.getValue(TextToSpeechInProgress.key) !== true;
			button.domNode.setAttribute('aria-pressed', String(reading));
		};
		row.updateReadAloud = update;
		lifetime.add(this.contextKeys.onDidChangeContext(event => { if (event.affectsSome(speechContextKeys)) update(); }));
		lifetime.add(CommandsRegistry.onDidChangeCommands(update));
		lifetime.add(addDisposableListener(row.element, 'keydown', event => {
			if ((event as KeyboardEvent).key !== 'Escape' || !row.reading.value) return;
			row.reading.clear(); update(); event.preventDefault(); event.stopPropagation();
		}));
		lifetime.add(button.onDidClick(() => {
			if (row.isDisposed || !this.visible) return;
			const current = row.reading.value;
			if (current) {
				void this.commands.executeCommand('workbench.action.chat.stopReadChatItemAloud', { source: current.source });
				return;
			}
			const item = row.item;
			const source = new CancellationTokenSource();
			const operation = Object.assign(toDisposable(() => source.dispose(true)), { source, item });
			row.reading.value = operation; feedback.textContent = ''; update();
			void this.commands.executeCommand('workbench.action.chat.readChatResponseAloud', { type: item.type, text: item.text, source }).catch(error => {
				if (!row.isDisposed && row.reading.value === operation && !source.token.isCancellationRequested && !isCancellationError(error)) {
					feedback.textContent = localize('chat.message.readAloudFailed', 'Could not read response aloud: {0}', String(error));
				}
			}).finally(() => {
				if (row.reading.value === operation) row.reading.clear();
				update();
			});
		}));
		update();
	}

	private renderMemoryReferences(row: RenderedItem): void {
		if (!this.onDidRequestMemoryReference) return;
		const references = [...new Set(row.item.text.match(/memory:[A-Za-z0-9_-]+/g) ?? [])].filter(reference => reference.length <= 4096).slice(0, 8);
		for (const [reference] of row.memoryReferences) {
			if (!references.includes(reference)) row.memoryReferences.deleteAndDispose(reference);
		}
		for (const [index, reference] of references.entries()) {
			let rendered = row.memoryReferences.get(reference);
			if (!rendered) {
				const button = h(row.element.ownerDocument, 'button');
				button.type = 'button';
				const click = addDisposableListener(button, 'click', () => this.onDidRequestMemoryReference?.(reference));
				rendered = row.memoryReferences.set(reference, Object.assign(toDisposable(() => { click.dispose(); button.remove(); }), { element: button }));
				row.element.append(button);
			}
			rendered.element.textContent = localize('chat.transcript.memoryReference', 'Open memory reference {0}', index + 1);
		}
	}

	private renderItem(item: IChatListItem): RenderedItem {
		const disposables = new DisposableStore();
		const article = h(this.element.ownerDocument, 'article');
		article.className = `${this.classPrefix}-item ${this.classPrefix}-item-${item.type}`;
		article.dataset.itemId = item.id;
		article.tabIndex = -1;
		if (item.transient) article.dataset.transient = 'true';
		if (item.isError) article.classList.add('error');
		if (item.toolInvocation) {
			const part = disposables.add(this.instantiationService.createInstance(ChatToolInvocationPart, article.ownerDocument, item.toolInvocation, item.attachmentSource, this.mcpAppDelegate));
			disposables.add(part.onDidChangeHeight(() => { this.relayout.schedule(); this._onDidChangeContent.fire(); }));
			article.append(part.domNode);
			return new RenderedItem(item, article, disposables, part);
		}
		if (item.type === 'hook' && item.hookPart) {
			const part = disposables.add(new ChatHookContentPart(article.ownerDocument, item.hookPart));
			article.append(part.domNode);
			return new RenderedItem(item, article, disposables, undefined, undefined, undefined, part);
		}
		if (item.type === 'userContext' && item.contextText !== undefined) {
			const label = h(article.ownerDocument, 'div');
			label.className = `${this.classPrefix}-item-label`;
			label.textContent = this.accessibilityProvider.getAriaLabel(item);
			const disclosure = h(article.ownerDocument, 'details');
			disclosure.className = 'ash-chat-context';
			const summary = h(article.ownerDocument, 'summary');
			summary.textContent = item.text;
			const content = h(article.ownerDocument, 'pre');
			content.textContent = item.contextText;
			content.tabIndex = 0;
			content.setAttribute('aria-label', item.text);
			disclosure.open = this.contextExpansion.get(item.id) ?? false;
			disclosure.append(summary, content);
			article.append(label, disclosure);
			disposables.add(addDisposableListener(disclosure, 'toggle', () => {
				this.contextExpansion.set(item.id, disclosure.open);
				this.relayout.schedule();
			}));
			return new RenderedItem(item, article, disposables, undefined, undefined, undefined, undefined, { disclosure, summary, content });
		}
		const label = h(this.element.ownerDocument, item.type === 'advisor' ? 'summary' : 'div');
		label.className = `${this.classPrefix}-item-label`;
		label.textContent = this.accessibilityProvider.getAriaLabel(item);
		const body = item.type === 'advisor' ? h(this.element.ownerDocument, 'details') : article;
		body.append(label);
		if (body !== article) {
			const disclosure = body as HTMLDetailsElement;
			disclosure.open = this.advisorExpansion.get(item.id) ?? true;
			disposables.add(addDisposableListener(disclosure, 'toggle', () => { this.advisorExpansion.set(item.id, disclosure.open); }));
			article.append(body);
		}
		let markdownPart: ChatMarkdownContentPart | undefined;
		if (item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'plan' || item.type === 'advisor') {
			const markdown = disposables.add(this.instantiationService.createInstance(ChatMarkdownContentPart, {
				ownerDocument: this.element.ownerDocument,
				visible: this.visible,
				deferCodeBlockModels: !!this.viewportObserver,
				markdown: { value: item.text, supportThemeIcons: true, supportAlertSyntax: true },
				markedOptions: { breaks: true },
				fillInIncompleteTokens: item.transient,
				actionHandler: this.onDidRequestLink ? (target: string) => this.onDidRequestLink!(target) : undefined,
				sanitizerConfig: { allowedLinkSchemes: { augment: [OPEN_SESSION_LINK_SCHEME] } },
				imageResourceLoader: this.imageResourceLoader,
			}));
			disposables.add(markdown.onDidChangeHeight(() => {
				this.relayout.schedule();
				if (this.viewportObserver) {
					this.pendingViewportMeasurements.add(item.id);
					this.refreshViewport.schedule();
				}
				this._onDidChangeContent.fire();
			}));
			markdownPart = markdown;
			body.append(markdown.domNode);
		} else {
			const content = h(this.element.ownerDocument, 'pre');
			content.textContent = item.text;
			body.append(content);
		}
		const attachments = h(article.ownerDocument, 'div');
		body.append(attachments);
		if (item.detail) {
			const detail = h(this.element.ownerDocument, 'p');
			detail.className = `${this.classPrefix}-turn-error-detail`;
			detail.textContent = item.detail;
			body.append(detail);
		}
		if (item.action) {
			const action = item.action;
			const button = disposables.add(new Button(article, {
				...defaultButtonStyles,
				label: action.label,
				presentation: 'secondary',
				size: 'small',
				onClick: () => this.onDidRequestErrorAction?.(action),
			}));
			button.domNode.classList.add(`${this.classPrefix}-turn-error-action`);
		}
		const row = new RenderedItem(item, article, disposables, undefined, markdownPart, attachments);
		if (item.type === 'agentMessage' || item.type === 'userMessage') this.renderCopyAction(row, disposables);
		return row;
	}
}

function sameToolInvocation(left: IChatListItem['toolInvocation'], right: IChatListItem['toolInvocation']): boolean {
	if (left === right) return true;
	return !!left && !!right && left.call === right.call && left.result === right.result && left.stopped === right.stopped
		&& left.output.length === right.output.length && left.output.every((output, index) => output === right.output[index]);
}

function sameItem(left: IChatListItem, right: IChatListItem): boolean {
	return left.id === right.id && left.type === right.type && left.text === right.text && left.contextText === right.contextText
		&& left.requestSource?.sessionId === right.requestSource?.sessionId && left.requestSource?.threadId === right.requestSource?.threadId
		&& left.requestSource?.turnId === right.requestSource?.turnId && left.requestSource?.itemId === right.requestSource?.itemId
		&& left.hookPart?.run === right.hookPart?.run
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
	return left.type !== 'retry' || (right.type === 'retry' && left.turnId === right.turnId);
}



function sameContent(left: IChatListItem['content'], right: IChatListItem['content']): boolean {
	if (left === right) return true;
	if (!left || !right || left.length !== right.length) return false;
	return left.every((part, index) => {
		const next = right[index];
		if (part.type !== next.type) return false;
		if (part.type === 'artifact') {
			return next.type === 'artifact'
				&& part.artifact.contentDigest === next.artifact.contentDigest
				&& part.artifact.mimeType === next.artifact.mimeType
				&& part.artifact.data.type === next.artifact.data.type
				&& part.artifact.truncated === next.artifact.truncated
				&& JSON.stringify(part.artifact.source) === JSON.stringify(next.artifact.source);
		}
		if (part.type === 'text') return next.type === 'text' && part.text === next.text;
		if ('url' in part) return 'url' in next && part.url === next.url;
		return 'attachment' in next && part.attachment.contentDigest === next.attachment.contentDigest;
	});
}
