import type { IChatInputPart } from './input/chatInputPart.js';
import type { ChatTurnChangesOpener } from '../chat.js';
import { PromptTimelineModel, type PromptTurnChanges } from '../promptTimeline/promptTimelineModel.js';
import { PromptTimelineWidgetContrib } from '../promptTimeline/promptTimelineWidgetContrib.js';
import { getImageGenerationBatch, isImageGenerationToolInvocation } from './chatContentParts/toolInvocationParts/chatToolPartUtilities.js';
import { ChatImageGenerationBatchPart } from './chatContentParts/chatImageGenerationBatchPart.js';
import type { IChatContentPart } from './chatContentParts/chatContentParts.js';
import { ChatListItemRenderer, type ChatRequestInputOptions, type ChatResponseActions } from './chatListRenderer.js';
import { cloneVisibleSelection, sanitizeChatClipboardFragment } from './chatClipboard.js';
import { ChatLayoutTrace } from './chatLayoutTrace.js';
import { ILoggerService } from '../../../../../platform/log/common/log.js';
import { autorun } from '../../../../../base/common/observable.js';
import { IChatLayoutService } from '../../common/widget/chatLayoutService.js';
import { findLast } from '../../../../../base/common/arraysFind.js';
import { PromptTimelineStickyHeader } from '../promptTimeline/promptTimelineStickyHeader.js';
import './media/chatListWidget.css';
import { addDisposableListener, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { ChatTurnErrorAction, IChatListItem } from '../../common/model/chatViewModel.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { BareFontInfo, EDITOR_FONT_DEFAULTS } from '../../../../../editor/common/config/fontInfo.js';
import { CodeEditorConfiguration } from '../../../codeEditor/common/editorConfiguration.js';
import { PROMPT_TIMELINE_STICKY_SCROLL_SETTING } from '../../common/promptTimeline.js';
import { ChatConfiguration, ChatEditorConfiguration, ChatInputConfiguration } from '../../common/constants.js';
import { observableConfigValue } from '../../../../../platform/observable/common/platformObservableUtils.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { DomWidget } from '../../../../../platform/domWidget/browser/domWidget.js';
import type { IChatMcpAppDelegate } from './chatContentParts/toolInvocationParts/chatMcpAppModel.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { localize } from '../../../../../nls.js';
import { ChatAccessibilityProvider } from '../accessibility/chatAccessibilityProvider.js';
import { ChatResponseAccessibleView } from '../accessibility/chatResponseAccessibleView.js';
import { ChatFindWidget, computeRevealScrollTop, type IChatFindHost } from './chatFind/chatFindWidget.js';
import type { ChatInputEditorOptions, IChatInputEditor } from './input/chatInputEditorRegistry.js';

interface ChatListWidgetOptions {
	readonly createRequestInput?: (options: ChatRequestInputOptions) => IChatInputPart;
	readonly createRequestEditor?: (options: ChatInputEditorOptions) => IChatInputEditor;
	readonly promptTimelineChanges?: (prompt: IChatListItem) => PromptTurnChanges | undefined;
	readonly showPromptTimeline?: boolean;
	readonly readResponseResource?: (item: IChatListItem, resource: URI, signal: AbortSignal) => Promise<Blob>;
	readonly getResponseLinkOpener?: (item: IChatListItem) => ((target: string) => Promise<void>) | undefined;
	readonly getResponseActions?: (item: IChatListItem) => ChatResponseActions | undefined;
	readonly openTurnChanges?: ChatTurnChangesOpener;
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
const viewportMargin = 600;

interface ReadingAnchor {
	readonly id: string;
	readonly viewportTop: number;
}

type RenderedImageBatch = DisposableStore & {
	readonly part: ChatImageGenerationBatchPart;
	readonly turnId: string;
	members: readonly string[];
};

interface ChatListViewState {
	readonly visible: boolean;
	readonly lastFocusedItemId?: string;
	readonly shouldFollow: boolean;
	readonly top: number;
	readonly anchor: ReadingAnchor | undefined;
	readonly advisorExpansion: readonly [string, boolean][];
	readonly contextExpansion?: readonly [string, boolean][];
	readonly toolExpansion?: readonly [string, boolean][];
	readonly thinkingExpansion?: readonly [string, boolean][];
	readonly focus: { readonly itemId: string; readonly index: number; readonly textInput?: boolean; } | undefined;
}

/** Renders the ordered user, Agent, reasoning, and tool items in one Chat pane. */
export class ChatListWidget extends DomWidget {
	// Disposed after the row collection so the final batch includes every row release.
	private readonly layoutTraceStore = this._register(new DisposableStore());
	private readonly findWidget = this._register(new MutableDisposable<ChatFindWidget>());
	private items: readonly IChatListItem[] = [];
	private lastFocusedItemId: string | undefined;
	private readonly domNode: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private readonly scrollToLatestButton: Button;
	private readonly scrollToLatestHostObserver = this._register(new MutableDisposable());
	private readonly transcript: HTMLDivElement;
	private readonly stickyPrompt: PromptTimelineStickyHeader;
	private promptModel = new PromptTimelineModel<IChatListItem>([], id => this.renderedItems.get(id)!.element);
	private readonly promptTimeline: PromptTimelineWidgetContrib | undefined;
	private pinnedPrompt: { readonly item: IChatListItem; readonly index: number; readonly total: number; } | undefined;
	private readonly layoutTrace: ChatLayoutTrace;
	private readonly renderedItems = this._register(new DisposableMap<string, ChatListItemRenderer>());
	private readonly imageBatches = this._register(new DisposableMap<string, RenderedImageBatch>());
	private readonly classPrefix: string;
	private readonly accessibilityProvider = new ChatAccessibilityProvider();
	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	private readonly advisorExpansion = new Map<string, boolean>();
	private readonly contextExpansion = new Map<string, boolean>();
	private readonly thinkingExpansion = new Map<string, boolean>();
	private visible = true;
	private shouldFollow = true;
	private activeRequestEdit: (() => boolean) | undefined;
	private readingPosition: ReadingAnchor | undefined;
	private layingOut = false;
	private readonly relayout = this._register(new RunOnceScheduler(() => { if (this.visible) this.layout(); }, 0));
	private pendingReadingPosition: { readonly top: number; readonly anchor: ReadingAnchor | undefined; } | undefined;
	private pendingItems: readonly IChatListItem[] | undefined;
	private readonly viewportObserver: IntersectionObserver | undefined;
	private readonly pendingViewportMeasurements = new Set<string>();
	private readonly refreshViewport = this._register(new RunOnceScheduler(() => this.refreshRowViewports(), 0));

	public get element(): HTMLElement { return this.domNode; }

	/** Places the list-owned control in the composer action row when the host supplies one. */
	public setScrollToLatestHost(host: HTMLElement | undefined, composerForm: HTMLElement | undefined): void {
		this.scrollToLatestHostObserver.clear();
		const overlapProperty = '--ash-chat-transcript-composer-overlap';
		const updateOverlap = () => {
			if (!host || !composerForm) {
				this.element.style.removeProperty(overlapProperty);
				this.element.classList.remove('ash-chat-transcript-overlaps-composer');
				return;
			}
			const composer = composerForm.getBoundingClientRect();
			if (!composer.height || !this.element.clientHeight) return;
			// Measure from the unextended edge so observing the list cannot accumulate overlap.
			const appliedMargin = parseFloat(host.ownerDocument.defaultView!.getComputedStyle(this.element).marginBlockEnd);
			const overlap = Math.max(0, Math.round(composer.top - this.element.getBoundingClientRect().bottom - appliedMargin));
			const value = `${overlap}px`;
			if (this.element.style.getPropertyValue(overlapProperty) !== value) {
				this.element.style.setProperty(overlapProperty, value);
				this.element.classList.toggle('ash-chat-transcript-overlaps-composer', overlap > 0);
			}
		};
		const target = host ?? this.element;
		const button = this.scrollToLatestButton.domNode;
		if (button.parentElement !== target) {
			const focused = button.ownerDocument.activeElement === button;
			target.append(button);
			if (focused) button.focus({ preventScroll: true });
		}
		updateOverlap();
		if (host && composerForm) {
			// Updating the list margin changes an observed box. Apply it outside observer delivery.
			const layout = new RunOnceScheduler(updateOverlap, 0);
			const targets = [this.element, host, composerForm];
			if (host.parentElement) targets.push(host.parentElement);
			const resize = observeResize(targets, () => layout.schedule());
			this.scrollToLatestHostObserver.value = toDisposable(() => {
				resize.dispose();
				layout.dispose();
				this.element.style.removeProperty(overlapProperty);
				this.element.classList.remove('ash-chat-transcript-overlaps-composer');
			});
		}
	}

	public getFindController(): ChatFindWidget {
		return this.findWidget.value ??= this.instantiationService.createInstance(ChatFindWidget, {
			element: this.element,
			onDidChange: this._onDidChangeContent.event,
			getItems: () => this.items,
			getRowElement: id => this.renderedItems.get(id)?.element,
			getViewportAnchorItemId: () => this.readingAnchor()?.id,
			reveal: (id, target) => this.revealItem(id, target),
			focus: () => this.focusReadingPosition(),
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
		this.renderedItems.get(item.id)?.thinkingPart?.expandContent();
		this.reveal(item);
		const row = this.renderedItems.get(item.id);
		const part: IChatContentPart | undefined = row?.toolPart ?? row?.markdownPart;
		const blocks = part?.codeblocks ?? [];
		if (!blocks.length) { return; }
		const document = this.element.ownerDocument;
		const current = blocks.findIndex(block => document.getElementById(block.elementId)?.contains(document.activeElement));
		const index = current < 0 ? (reverse ? blocks.length - 1 : 0) : (current + (reverse ? blocks.length - 1 : 1)) % blocks.length;
		blocks[index].focus();
	}

	public getFocus(): IChatListItem | undefined {
		return this.lastFocusedItemId ? this.renderedItems.get(this.lastFocusedItemId)?.item : undefined;
	}

	public getFileTreeInfosForResponse(item: IChatListItem) { return this.renderedItems.get(item.id)?.getFileTreeInfos() ?? []; }
	public getLastFocusedFileTreeForResponse(item: IChatListItem) { return this.renderedItems.get(item.id)?.getLastFocusedFileTree(); }

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

	/** Return focus to the message at the current reading position without scrolling. */
	public focusReadingPosition(): void {
		if (!this.visible) return;
		const anchor = this.readingAnchor();
		const row = anchor && this.renderedItems.get(anchor.id);
		(row?.element ?? this.transcript).focus({ preventScroll: true });
	}

	/** Source changes retire the query, its pending history work and borrowed render ranges together. */
	public resetFind(): void { this.findWidget.clear(); }

	constructor(
		container: HTMLElement, private readonly options: ChatListWidgetOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatLayoutService chatLayoutService: IChatLayoutService,
		@ILoggerService loggerService: ILoggerService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.layoutTrace = this.layoutTraceStore.add(new ChatLayoutTrace(() => performance.now(), loggerService.createLogger('chat.layout')));
		this.classPrefix = options.classPrefix ?? 'ash-chat';
		this.scrollable = this._register(new ScrollableElement(container, {
			direction: 'vertical',
			vertical: 'auto',
			tabIndex: -1,
		}));
		this.shouldFollow = this.canFollowReplies();
		this._register(this.scrollable.onDidScroll(event => {
			if (this.layingOut || !this.visible) return;
			this.updateReplyFollowing(event.current.top, event.current.maximumTop);
			this.updateStickyPrompt();
			this.updateScrollToLatestVisibility();
		}));
		this.domNode = this.scrollable.element;
		this.element.classList.add('ash-chat-transcript-viewport', `${this.classPrefix}-list-widget`, `${this.classPrefix}-transcript-scrollable`);
		// Keep the native scroll container out of the Tab order when it has no tabbable children.
		this.scrollable.scrollableElement.tabIndex = -1;
		this.transcript = this.scrollable.contentElement;
		this.transcript.classList.add('ash-chat-transcript-content', `${this.classPrefix}-transcript`);
		this.transcript.setAttribute('role', 'log');
		this.transcript.tabIndex = -1;
		this.transcript.setAttribute('aria-label', this.accessibilityProvider.getWidgetAriaLabel());
		this.transcript.setAttribute('aria-live', 'polite');
		this.transcript.setAttribute('aria-busy', 'false');
		const scrollToLatestLabel = localize('chat.scrollToLatest', 'Scroll to Latest');
		this.scrollToLatestButton = this._register(new Button(this.element, {
			...defaultButtonStyles,
			label: scrollToLatestLabel,
			title: scrollToLatestLabel,
			icon: Lxicon.arrowDown,
			iconOnly: true,
			presentation: 'secondary',
		}));
		this.scrollToLatestButton.toggleClassName('ash-chat-scroll-to-latest', true);
		this.scrollToLatestButton.hidden = true;
		this._register(this.scrollToLatestButton.onDidClick(() => this.scrollToLatest()));
		this.stickyPrompt = this._register(new PromptTimelineStickyHeader(this.scrollable.scrollableElement));
		this._register(this.stickyPrompt.onDidActivate(() => {
			const prompt = this.pinnedPrompt?.item;
			if (!prompt) return;
			this.focus(prompt);
			this.revealItem(prompt.id, undefined, true);
		}));
		const promptTimelineChanges = options.promptTimelineChanges;
		if (options.showPromptTimeline || promptTimelineChanges) {
			this.promptTimeline = this._register(instantiationService.createInstance(PromptTimelineWidgetContrib,
				this.element, this.scrollable.scrollableElement, {
				reveal: (id: string) => {
					const prompt = this.renderedItems.get(id)?.item;
					if (prompt) {
						this.focus(prompt);
						this.revealItem(id, undefined, true);
					}
				},
				changes: (id: string) => {
					const prompt = this.renderedItems.get(id)?.item;
					return prompt && promptTimelineChanges?.(prompt);
				},
			}, () => this.renderPromptTimeline()));
		}

		this._register(addDisposableListener<ClipboardEvent>(this.transcript, 'copy', event => {
			if (event.defaultPrevented || !this.visible || !event.clipboardData) { return; }
			const target = event.target as Element | null;
			// Input and code editors own their clipboard formats and selection semantics.
			if (target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]')) { return; }
			const selection = this.transcript.ownerDocument.defaultView?.getSelection();
			if (!selection || selection.isCollapsed || !selection.rangeCount) { return; }
			const holder = this.transcript.ownerDocument.createElement('div');
			let changed = false;
			for (let index = 0; index < selection.rangeCount; index++) {
				const range = selection.getRangeAt(index);
				if (!this.transcript.contains(range.commonAncestorContainer)) { return; }
				const fragment = cloneVisibleSelection(range, this.transcript);
				changed = sanitizeChatClipboardFragment(fragment) || changed;
				holder.append(fragment);
			}
			if (!changed) { return; }
			event.clipboardData.setData('text/plain', selection.toString());
			event.clipboardData.setData('text/html', holder.innerHTML);
			event.preventDefault();
		}));
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
				if (!active || (!this.transcript.contains(active) && active !== this.stickyPrompt.domNode && !this.promptTimeline?.contains(active))) return undefined;
				const provider = new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type: AccessibleViewType.Help }, () => {
					const forkHelp = [
						localize('chat.restoreCheckpoint.help', 'Tab to Restore checkpoint and press Enter or Space. Choose Before this message or After this message to restore that checkpoint in a new chat.'),
						localize('chat.forkConversation.help', 'Tab to Fork conversation from this point and press Enter or Space to open a new chat with the history before that request. In the Agents window, use Alt+Enter or Alt-click to open it side by side.'),
						localize('chat.queue.rowHelp', 'On a queued message, use Tab to reach Edit queued message, Send queued message immediately, or Remove queued message. Press Enter or Space to apply the action to that message.'),
						localize('chat.history.redoRowHelp', 'After undoing a request, use Redo last request in the transcript to restore the request and its recorded file changes.'),
						localize('chat.modelFeedback.rowHelp', 'Give model feedback on a completed reply opens an editable report about the model used for that reply.'),
						...(this.options.openTurnChanges ? [localize('chat.turnChanges.help', 'When a completed reply has captured file changes, use Tab to reach its file count button. Press Enter or Space to open the before-and-after comparison for that turn.')] : []),
					].join('\n');
					return (this.promptTimeline ? localize('chat.promptTimeline.help', 'In the Agents window, hover over the left timeline to show prompts, or focus Show prompts and press Enter. Use Up and Down Arrow, Home or End to move between prompts, and Left and Right Arrow to switch between a prompt and its change counts. Activate the prompt to jump to it or the counts to open that turn’s changes. In the ruler, activate a marker to see the same actions and expand Changed files to review an individual file. Escape closes the prompt list.') + '\n' : '') + localize('chat.stickyScroll.help', 'When a user prompt scrolls out of view, it stays at the top of the conversation. Tab to the pinned prompt and press Enter or Space to return to the original message.') + '\n' + localize('chat.requests.help', 'Click an editable request to edit its text in place. With the keyboard, Tab to its edit control and press Enter or Space. Enter inserts a line; Ctrl or Command+Enter sends it into a new chat with its original context and attachments. Click outside the editor or press Escape to cancel and keep the original request and draft. Fork Conversation in the Command Palette copies the current history without sending. Use New Chat to start an empty conversation. These actions preserve the original conversation.') + '\n' + forkHelp + '\n' + localize('chat.remainingActions.help', 'Chat: Configure Tools edits the focused draft’s tool selection; Escape discards changes. Chat: Approve Tool Once and Chat: Decline Tool act only on the currently displayed approval. They never save an approval rule. Chat: Submit Requested Answers submits the current question form with its entered values; required answers must be filled. Use Ctrl or Command+Enter while the question form has focus. Chat: Retry Failed Request repeats an available failed request through its original retry policy. Chat: Copy Final Response copies the latest completed assistant reply without speaker labels or streaming text. Chat: Next Code Block and Chat: Previous Code Block move focus through the current or latest response’s code blocks and wrap at the ends. Use Ctrl or Command+Alt+Page Down or Page Up in Chat. Chat: Export Conversation Transcript saves a frozen backend text snapshot, including voice transcripts, tool call summaries with inputs and errors, and partial markers. Tool output, result attachments and internal reasoning are excluded. Chat: Open Saved Transcript (Read-Only) opens a supported saved document in a read-only editor; it does not restore or execute a conversation. These commands keep the unsent draft.') + '\n' + localize('chat.pickers.commandHelp', 'Use Chat: Open Model Picker, Chat: Open Mode or Agent Picker, or Chat: Open Permission Picker in the Command Palette to configure the most recently focused composer. Model and mode pickers also open with {0} and {1}. Fixed-mode inputs keep the mode picker hidden. Cowork uses its existing permission flow. Escape closes a picker. Opening or cancelling keeps the draft and attachments without sending. Switching conversations retires pending selections and permission confirmations.', '<keybinding:workbench.action.chat.openModelPicker>', '<keybinding:workbench.action.chat.openModePicker>') + '\n' + localize('chat.execution.help', 'Chat: Send Message uses the current draft, attachments and submission policy. Chat: Add Message to Queue waits for the current request to finish; Chat: Steer with Message explicitly targets it. When idle, both send normally. Explicit steering rejects a different mode, Skill or task type. Queue and steering actions do not run slash commands. Failed submissions restore the draft if it has not been edited again. Use {0} to stop the focused task while keeping unsent text. Stopping remains available for running work when AI features are disabled.', '<keybinding:workbench.action.chat.cancel>') + '\n' + localize('chat.queue.manageHelp', 'Use Chat: Edit Queued Message, Chat: Remove Queued Message or Chat: Send Queued Message Immediately in the Command Palette, then select a message in queue order. Editing pauses that message and preserves attached inputs and your unsent draft. Enter keeps the edited message’s queue or steering action; Alt+Enter uses the other action. Ctrl or Command+Enter saves; Escape restores a previously pending message at its original position. Previously paused or failed messages remain paused when editing is cancelled. A changed revision requires choosing the message again. Send Immediately moves the original message to the front and stops the current task before running it. Remove All Queued Messages removes the captured revisions and keeps messages added while the action runs.') + '\n' + localize('chat.navigation.help', 'Use {0} to focus the latest response and {1} to return to the last focused message. Use {2} and {3} to move between user prompts without wrapping. Navigation includes loaded messages; load earlier messages to reach older prompts. On macOS, the input-to-list shortcut applies only on the first visual input line. Quick Chat reverses the input-to-list shortcut direction. Use {4} to focus a pending confirmation or return to the input. Focusing never accepts or declines a request, sends a message or changes the draft.', '<keybinding:chat.action.focus>', '<keybinding:workbench.chat.action.focusLastFocused>', '<keybinding:workbench.action.chat.previousUserPrompt>', '<keybinding:workbench.action.chat.nextUserPrompt>', '<keybinding:workbench.action.chat.focusConfirmation>') + '\n' + localize('chat.find.commandsHelp', 'Use {0} to find text in this conversation. Find includes complete code blocks and continues through earlier history without sending or changing the draft. Use the result controls to navigate; Escape closes Find and restores focus.', '<keybinding:workbench.action.chat.find>') + '\n' + localize('chat.commands.help', 'Use Focus Chat Input in the Command Palette to return to the most recently focused Chat input. From a conversation, use {0} to return to its input. Chat: Copy Conversation in the Command Palette copies all text messages and voice transcripts, including earlier history. Markdown is preserved. Export Transcript in the conversation title menu saves a JSON snapshot of the conversation. Draft text is kept in the input.', '<keybinding:workbench.action.chat.focusInput>') + '\n' + localize('chat.naming.help', 'New conversations take an initial name from the first message. Use Chat: Rename Conversation in the Command Palette to set a name. Enter saves it and Escape cancels. Manual names are kept when automatic naming finishes later.') + '\n' + localize('chat.history.paginationHelp', 'Chat initially shows recent messages. Use Tab to reach Load earlier messages, then Enter or Space to load another page. Loading preserves your draft, active approvals and reading position. If it fails, use Retry earlier messages. Live messages remain available while older history loads.') + '\n' + localize('chat.transcript.help', 'Chat responses\nWith a Speech extension, use Read aloud on a completed response. The same button stops reading; Escape also stops it. Hiding or removing the response cancels reading. Use Stop reading aloud in the Command Palette after moving focus elsewhere. Use Tab and Shift+Tab to reach message copy actions, response links, code block actions and tool summaries. Copy message preserves Markdown and copies internal resource links as code labels. Copying a selection also replaces internal links with their visible labels. Tool summaries describe the activity and its current result state. Press Enter or Space on a tool summary to inspect its source and execution target. Input, standard output, standard error and result each have a separate summary; press Enter or Space to expand or collapse them. Tab to an expanded text region and use the arrow keys to scroll long output. Tool text is displayed literally. Code block actions copy the complete source, insert it into the active editor, or open it in a new unsaved file. Use context summaries to inspect the exact text attached to a request. Use resource summaries to inspect returned data and Open resource for a read-only preview. Use Load image or Load audio to read a stored attachment. Open image or Open audio opens its original bytes in a read-only editor. Opening audio pauses the transcript player. Open interactive view loads a declared MCP App; use Tab or Shift+Tab to reach its controls and Close interactive view to return focus. Streaming updates and provider corrections keep code selections, keyboard focus and expansion. When Automatically follow new replies is enabled in Chat settings, returning to the bottom resumes following. Scrolling up or editing a message pauses following. While reading earlier messages, use Scroll to Latest to jump to the bottom. Failed calls show an error; a finished turn without a result is never shown as successful. Use <keybinding:editor.action.accessibleView> to read the transcript as plain text, including collapsed tool details. Closing this view returns focus to the response.') + '\n' + localize('chat.media.copyHelp', 'For a loaded local image, use Tab to reach Copy image and press Enter or Space to copy it to the clipboard.') + '\n' + localize('chat.markdown.tableScrollHelp', 'Use Tab to focus a response table and Left or Right Arrow to scroll wide tables. Find in Chat scrolls the table to the matching cell.') + '\n' + localize('chat.thinking.help', 'Reasoning starts collapsed. Press Enter or Space on its summary to expand or collapse it. Streaming updates and completion keep your expansion and keyboard focus. Code block navigation expands the matching reasoning when needed. The accessible transcript includes reasoning even while collapsed.') + '\n' + localize('chat.imageGeneration.help', 'Generated images appear outside the tool details. Use Open image for a read-only preview of the original image, or Download to save it. Progress ends with a reveal after decoding; reduced motion and high contrast show the result directly. Failure or stopping ends progress, and restored history does not replay generation animations.') + '\n' + localize('chat.response.feedbackHelp', 'Completed IDE Chat responses offer Helpful. Press Enter or Space to save a personal helpful mark for that response; reopening Chat retains it. Feedback stays in the current Ash profile and is not sent to the model provider or used to change the response. Choose Helpful response animation in Settings to change or disable the effect. Reduced motion also disables the animation.') + '\n' + localize('chat.typography.help', 'In Settings, open Chat, then Appearance to change the message font and text size, including Markdown and links. Message input and code blocks have separate font settings. Changes keep your draft and reading position.');
				}, () => { if (active.isConnected) active.focus(); }, AccessibilityVerbositySettingId.Chat);
				provider.onDidChangeContent = this._onDidChangeContent.event;
				return provider;
			},
		}));
		this._register(AccessibleViewRegistry.register(new ChatResponseAccessibleView({
			// Retained rows own the current items; DOM order also reflects message reordering.
			getItems: () => Array.from(this.transcript.children, element => this.renderedItems.get((element as HTMLElement).dataset.itemId!)!.item),
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
			if (event.affectsConfiguration(ChatConfiguration.AutoFollowReplies)) {
				const { top, maximumTop } = this.scrollable.state;
				this.updateReplyFollowing(top, maximumTop);
			}
			if (event.affectsConfiguration(PROMPT_TIMELINE_STICKY_SCROLL_SETTING)) this.updateStickyPrompt();
			const keys = [...Object.values(ChatEditorConfiguration), CodeEditorConfiguration.fontFamily, CodeEditorConfiguration.fontSize, CodeEditorConfiguration.lineHeight];
			if (!keys.some(key => event.affectsConfiguration(key))) return;
			if (this.visible) this.captureFollowState();
			const anchor = this.visible && !this.shouldFollow ? this.readingPosition : undefined;
			this.updateCodeBlockOptions();
			if (this.visible) this.layout(anchor);
		}));
		const requestFontSize = contextKeys.getValue<boolean>(IsSessionsWindowContext.key)
			? observableConfigValue(ChatInputConfiguration.fontSize, 14, this.configurationService)
			: undefined;
		this._register(autorun(reader => {
			const family = chatLayoutService.fontFamily.read(reader);
			const size = chatLayoutService.fontSize.read(reader);
			const requestSize = requestFontSize?.read(reader);
			if (this.visible) this.captureFollowState();
			const anchor = this.visible && !this.shouldFollow ? this.readingPosition : undefined;
			this.transcript.style.fontFamily = family ?? '';
			this.transcript.style.fontSize = `${size}px`;
			if (requestSize !== undefined) this.transcript.style.setProperty('--ash-chat-request-font-size', `${requestSize}px`);
			// Font changes reflow retained rows; restore the position captured before the change.
			if (this.visible) this.layout(anchor, false);
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

	setBusy(busy: boolean): void {
		const value = String(busy);
		if (this.transcript.getAttribute('aria-busy') !== value) this.transcript.setAttribute('aria-busy', value);
	}

	private reconcile(items: readonly IChatListItem[]): void {
		if (this.visible) this.captureFollowState();
		const anchor = this.visible && !this.shouldFollow ? this.readingPosition : undefined;
		const active = this.element.ownerDocument.activeElement;
		const focusedRow = this.lastFocusedItemId ? this.renderedItems.get(this.lastFocusedItemId) : undefined;
		const focusedActionRowId = (focusedRow?.item.queueTarget || focusedRow?.item.historyRedoTarget || focusedRow?.item.turnChanges) && focusedRow.element.contains(active)
			? focusedRow.item.id : undefined;
		const imageFocus = isHTMLElement(active) && [...this.imageBatches].some(([, entry]) => entry.part.domNode.contains(active)) ? active : undefined;
		let changed = false;
		const ids = new Set(items.map(item => item.id));
		for (const [id, row] of this.renderedItems) {
			if (ids.has(id)) continue;
			this.viewportObserver?.unobserve(row.element);
			this.renderedItems.deleteAndDispose(id);
			this.pendingViewportMeasurements.delete(id);
			changed = true;
		}
		let next: ChildNode | null = this.transcript.firstChild;
		for (const item of items) {
			let row = this.renderedItems.get(item.id);
			const update = row?.update(item);
			if (row && update === 'unchanged') {
				if (row.element !== next) { this.transcript.insertBefore(row.element, next); changed = true; }
				next = row.element.nextSibling;
				continue;
			}
			changed = true;
			if (!row || update === 'replace') {
				if (row?.element === next) next = row.element.nextSibling;
				if (row) this.viewportObserver?.unobserve(row.element);
				// Retire the previous row before its replacement starts attachment work.
				this.renderedItems.deleteAndDispose(item.id);
				row = this.renderedItems.set(item.id, this.instantiationService.createInstance(ChatListItemRenderer, item, this.element.ownerDocument, {
					...this.options,
					classPrefix: this.classPrefix,
					deferCodeBlockModels: !!this.viewportObserver,
					isVisible: () => this.visible,
					advisorExpansion: this.advisorExpansion,
					contextExpansion: this.contextExpansion,
					thinkingExpansion: this.thinkingExpansion,
					onDidChangeHeight: () => this.relayout.schedule(),
					beginRequestEdit: (close: () => boolean) => {
						if (this.activeRequestEdit && !this.activeRequestEdit()) return undefined;
						this.activeRequestEdit = close;
						return toDisposable(() => {
							if (this.activeRequestEdit === close) this.activeRequestEdit = undefined;
						});
					},
					onWillChangeRequestEditor: (opening: boolean) => {
						const anchor = this.readingAnchor();
						return () => {
							// Edit controls take space in the row. Keep the viewport on the
							// same content even when it was following the end of the chat.
							this.shouldFollow = false;
							this.readingPosition = anchor;
							this.layout(anchor, false);
							const { top, maximumTop } = this.scrollable.state;
							if (!opening) this.updateReplyFollowing(top, maximumTop);
						};
					},
					onDidChangeMarkdownHeight: (id: string) => {
						if (this.viewportObserver) {
							this.pendingViewportMeasurements.add(id);
							this.refreshViewport.schedule();
						}
					},
					onDidChangeContent: () => this._onDidChangeContent.fire(),
				}, this.layoutTrace));
				this.viewportObserver?.observe(row.element);
				if (this.viewportObserver) this.pendingViewportMeasurements.add(item.id);
			}
			if (this.viewportObserver && row.markdownPart) this.pendingViewportMeasurements.add(item.id);
			if (row.element !== next) this.transcript.insertBefore(row.element, next);
			next = row.element.nextSibling;
		}
		changed = this.renderImageBatches(items) || changed;
		this.promptModel = new PromptTimelineModel(items.filter(item => item.type === 'userMessage'), id => this.renderedItems.get(id)!.element);
		// Reparenting a retained gallery can blur its button. Restore only that button,
		// and never replace focus deliberately moved elsewhere by a render listener.
		if (imageFocus?.isConnected && this.element.ownerDocument.activeElement === this.element.ownerDocument.body) {
			imageFocus.focus({ preventScroll: true });
		}
		if (focusedActionRowId && !active?.isConnected && this.element.ownerDocument.activeElement === this.element.ownerDocument.body) {
			const row = this.renderedItems.get(focusedActionRowId);
			if (row) this.focus(row.item);
			else this.focusReadingPosition();
		}
		if (this.lastFocusedItemId && !ids.has(this.lastFocusedItemId)) { this.lastFocusedItemId = undefined; }
		for (const id of this.contextExpansion.keys()) if (!ids.has(id)) this.contextExpansion.delete(id);
		for (const id of this.advisorExpansion.keys()) if (!ids.has(id)) this.advisorExpansion.delete(id);
		for (const id of this.thinkingExpansion.keys()) if (!ids.has(id)) this.thinkingExpansion.delete(id);
		// Reconciliation can temporarily shorten the DOM scroll range. Keep the position
		// captured before moving retained widgets instead of interpreting that clamp as user input.
		if (changed) {
			if (this.visible) this.layout(anchor, false);
			if (this.pendingViewportMeasurements.size) this.refreshRowViewports();
			this._onDidChangeContent.fire();
		} else if (this.visible) {
			this.renderPromptTimeline();
		}
	}

	private renderImageBatches(items: readonly IChatListItem[]): boolean {
		const used = new Set<string>();
		let changed = false;
		for (let index = 0; index < items.length; index++) {
			const call = items[index].toolInvocation;
			if (!call || !isImageGenerationToolInvocation(call)) { continue; }
			const batch = getImageGenerationBatch(items, call.call.toolCallId, call.call.turnId);
			index += batch.length - 1;
			const members = new Set(batch.map(item => item.id));
			// Match surviving members so extending history or removing a batch's first
			// row does not create another media owner or read the same attachments again.
			const retained = [...this.imageBatches].find(([key, entry]) => !used.has(key)
				&& entry.turnId === call.call.turnId && entry.members.some(id => members.has(id)));
			const key = retained?.[0] ?? batch[0].id;
			let entry = retained?.[1];
			if (!entry) {
				const part = this.instantiationService.createInstance(ChatImageGenerationBatchPart, this.element.ownerDocument);
				entry = this.imageBatches.set(key, Object.assign(new DisposableStore(), { part, turnId: call.call.turnId, members: [] as readonly string[] }));
				entry.add(part);
				entry.add(part.onDidChangeHeight(() => { this.relayout.schedule(); this._onDidChangeContent.fire(); }));
				part.setVisible(this.visible);
				changed = true;
			}
			used.add(key);
			entry.members = [...members];
			const host = this.renderedItems.get(batch.at(-1)!.id)?.toolPart?.domNode;
			if (host && entry.part.domNode.parentElement !== host) {
				host.append(entry.part.domNode);
				changed = true;
			}
			entry.part.render(batch);
		}
		for (const key of this.imageBatches.keys()) {
			if (!used.has(key)) { this.imageBatches.deleteAndDispose(key); changed = true; }
		}
		return changed;
	}

	setVisible(visible: boolean): void {
		// A replacement can already be visible and still have a reading position to restore.
		if (this.visible === visible && !(visible && this.pendingReadingPosition)) return;
		if (!visible) {
			this.relayout.cancel();
			this.refreshViewport.cancel();
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
		for (const [, entry] of this.imageBatches) { entry.part.setVisible(visible); }
		if (!visible) {
			this.findWidget.value?.hide();
			this.updateStickyPrompt();
			this.updateScrollToLatestVisibility();
			this.renderPromptTimeline();
		}
		for (const [, row] of this.renderedItems) {
			row.setVisible(visible);
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

	private revealItem(id: string, target?: { readonly top: number; readonly bottom: number; }, alignToTop = false): void {
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
			const bottom = viewport.bottom + Math.min(0, parseFloat(this.element.ownerDocument.defaultView!.getComputedStyle(this.element).marginBlockEnd));
			const next = alignToTop ? this.scrollable.state.top + bounds.top - viewport.top
				: computeRevealScrollTop(this.scrollable.state.top, Math.max(1, bottom - top - 8), bounds.top - top, bounds.bottom - top);
			if (next !== undefined) { this.scrollable.scrollTo(0, next); }
			this.readingPosition = this.readingAnchor();
			this.updateStickyPrompt();
			this.updateScrollToLatestVisibility();
		} finally { this.layingOut = false; }
	}

	private updateRowViewport(row: ChatListItemRenderer): void {
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
			thinkingExpansion: [...this.renderedItems].flatMap(([id, row]) => row.thinkingPart ? [[id, row.thinkingPart.domNode.open] as [string, boolean]] : []),
			focus,
		};
	}

	/** Re-renders from the model, then restores reading position after the host mounts the new root. */
	public restoreViewState(state: ChatListViewState, items: readonly IChatListItem[]): void {
		for (const [id, expanded] of state.contextExpansion ?? []) this.contextExpansion.set(id, expanded);
		for (const [id, expanded] of state.advisorExpansion) this.advisorExpansion.set(id, expanded);
		for (const [id, expanded] of state.thinkingExpansion ?? []) this.thinkingExpansion.set(id, expanded);
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
		for (const [id, expanded] of state.thinkingExpansion ?? []) {
			const part = this.renderedItems.get(id)?.thinkingPart;
			if (part) {
				part.domNode.open = expanded;
				part.setVisible(this.visible);
			}
		}
		// Hide the replacement before installing saved state: hiding captures its current scroll.
		this.setVisible(state.visible);
		this.shouldFollow = state.shouldFollow && this.canFollowReplies();
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

	private canFollowReplies(): boolean {
		return !this.activeRequestEdit && this.configurationService.getValue<boolean>(ChatConfiguration.AutoFollowReplies) !== false;
	}

	private scrollToLatest(): void {
		if (!this.visible) return;
		this.layingOut = true;
		try {
			this.scrollable.layout();
			this.scrollable.scrollTo(0, this.scrollable.state.maximumTop);
			const { top, maximumTop } = this.scrollable.state;
			this.updateReplyFollowing(top, maximumTop);
			this.updateStickyPrompt();
			this.updateScrollToLatestVisibility();
		} finally { this.layingOut = false; }
	}

	private updateScrollToLatestVisibility(): void {
		const { top, maximumTop } = this.scrollable.state;
		const hidden = !this.visible || maximumTop - top <= 1;
		if (hidden === this.scrollToLatestButton.hidden) return;
		this.element.classList.toggle('ash-chat-transcript-has-more-below', !hidden);
		if (hidden && this.visible && this.element.ownerDocument.activeElement === this.scrollToLatestButton.domNode) {
			const latest = this.items.at(-1);
			if (latest) this.focus(latest);
			else this.focusReadingPosition();
		}
		this.scrollToLatestButton.hidden = hidden;
	}

	private updateReplyFollowing(top: number, maximumTop: number): void {
		// The native scroll position and rounded scroll range can differ by one pixel at the bottom.
		this.shouldFollow = this.canFollowReplies() && maximumTop - top <= 1;
		this.readingPosition = this.shouldFollow ? undefined : this.readingAnchor();
	}

	private captureFollowState(): boolean {
		// DOM scrolling can precede its scroll event. Capture it before layout consumes that
		// position, otherwise an async size measurement can mistake reading for following.
		const state = this.scrollable.state;
		const viewport = this.scrollable.scrollableElement;
		const scrolled = viewport.scrollTop !== state.top;
		if (scrolled) {
			// A shrinking composer or transcript can clamp the native viewport before
			// the scrollbar has measured the new range. That clamp is still at bottom.
			const maximumTop = Math.min(state.maximumTop, viewport.scrollHeight - viewport.clientHeight);
			this.updateReplyFollowing(viewport.scrollTop, maximumTop);
		}
		this.layingOut = true;
		try { this.scrollable.layout(); }
		finally { this.layingOut = false; }
		this.updateScrollToLatestVisibility();
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
			this.updateStickyPrompt();
			this.updateScrollToLatestVisibility();
		} finally { this.layingOut = false; }
		this.renderPromptTimeline();
	}

	private renderPromptTimeline(): void {
		this.promptTimeline?.render(this.promptModel, this.visible && !this.transcript.style.paddingTop);
	}

	private updateStickyPrompt(): void {
		let item: IChatListItem | undefined;
		let index = 0;
		const { prompts } = this.promptModel;
		const total = prompts.length;
		if (this.visible && !this.transcript.style.paddingTop) {
			const viewport = this.scrollable.scrollableElement.getBoundingClientRect();
			index = this.promptModel.firstPromptAfter(viewport.top);
			const active = prompts[index - 1];
			this.promptTimeline?.setActive((active ?? prompts[0])?.id);
			// Keep the original row at the top when revealing it. Pin only after
			// it crosses the edge by enough to absorb fractional scroll positions.
			if (viewport.height > 0 && active && this.promptModel.bounds(active).top < viewport.top - 2
				&& this.configurationService.getValue<boolean>(PROMPT_TIMELINE_STICKY_SCROLL_SETTING) !== false) {
				item = active;
			}
		}
		const pinned = this.pinnedPrompt;
		if (item) {
			if (pinned?.item === item && pinned.index === index && pinned.total === total) {
				return;
			}
			this.pinnedPrompt = { item, index, total };
			this.stickyPrompt.update(item.text, index, total);
			this.stickyPrompt.setVisible(true);
		} else if (pinned) {
			this.pinnedPrompt = undefined;
			if (this.stickyPrompt.domNode === this.element.ownerDocument.activeElement && this.visible) {
				this.focusReadingPosition();
			}
			this.stickyPrompt.setVisible(false);
		}
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

}
