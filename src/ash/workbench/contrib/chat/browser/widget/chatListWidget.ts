import type { MemoryNamespace } from '../../../../../platform/memories/common/memoriesService.js';
import type { ChatMarkdownEntity } from '../../common/model/chatMarkdownRichContent.js';
import type { ChatTurnChangesOpener } from '../chat.js';
import { PromptTimelineModel } from '../promptTimeline/promptTimelineModel.js';
import type { IChatResponseFileChangesService } from '../chatResponseFileChangesService.js';
import { PromptTimelineWidgetContrib } from '../promptTimeline/promptTimelineWidgetContrib.js';
import { getImageGenerationBatches } from './chatContentParts/toolInvocationParts/chatToolPartUtilities.js';
import { ChatImageGenerationBatchPart } from './chatContentParts/chatImageGenerationBatchPart.js';
import type { IChatContentPart } from './chatContentParts/chatContentParts.js';
import { ChatListItemRenderer, type ChatResponseActions } from './chatListRenderer.js';
import { ChatPendingDragController } from './chatPendingDragAndDrop.js';
import { cloneVisibleSelection, sanitizeChatClipboardFragment } from './chatClipboard.js';
import { ChatLayoutTrace } from './chatLayoutTrace.js';
import { ChatWorkingProgressContentPart } from './chatContentParts/chatProgressContentPart.js';
import { ILoggerService } from '../../../../../platform/log/common/log.js';
import { autorun, type IObservable } from '../../../../../base/common/observable.js';
import { IChatLayoutService } from '../../common/widget/chatLayoutService.js';
import { findLast, findLastIdx } from '../../../../../base/common/arraysFind.js';
import { PromptTimelineStickyHeader } from '../promptTimeline/promptTimelineStickyHeader.js';
import './media/chatListWidget.css';
import { addDisposableListener, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { observeMutations, observeResize } from '../../../../../base/browser/observer.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { ChatStreamingResponseUpdate, ChatTurnErrorAction, IChatListItem } from '../../common/model/chatViewModel.js';
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
import { getChatLinkPreviewAccessibilityHelp } from '../actions/chatAccessibilityHelp.js';
import { computeRevealScrollTop } from './chatFind/chatFindWidget.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { ChatVirtualRows } from './chatVirtualRows.js';
import type { ChatToolDisclosureState } from './chatContentParts/toolInvocationParts/chatToolProgressPart.js';

interface ChatListWidgetOptions {
	readonly messagePresentation?: import('../chat.js').ChatMessagePresentation;
	readonly codeBlockPresentation?: 'card';
	readonly onDidRequestEdit?: (requestId: string) => void | Promise<void>;
	readonly canEditRequest?: () => boolean;
	readonly submitRequestEdit?: (item: IChatListItem, text: string, commandId: string) => Promise<void>;
	readonly getRequestVersions?: (item: IChatListItem) => Promise<readonly import('../chat.js').ChatRequestVersion[]>;
	readonly promptTimelineChanges?: IChatResponseFileChangesService['getChangesForRequest'];
	readonly getTurnChanges?: IChatResponseFileChangesService['getChangesForResponse'];
	readonly showPromptTimeline?: boolean;
	readonly virtualizeHistoryFrom?: IObservable<number | undefined>;
	readonly readResponseResource?: (item: IChatListItem, resource: URI, signal: AbortSignal) => Promise<Blob>;
	readonly inspectResponseEntity?: (item: IChatListItem, entity: ChatMarkdownEntity, anchor: HTMLElement) => Promise<void>;
	readonly getResponseActions?: (item: IChatListItem) => ChatResponseActions | undefined;
	readonly openTurnChanges?: ChatTurnChangesOpener;
	/** The host owns its transcript layout; content parts keep their shared styles. */
	readonly classPrefix?: string;
	readonly mcpAppDelegate?: IChatMcpAppDelegate;
	readonly memoryNamespace?: MemoryNamespace;
	readonly onDidRequestMemoryReference?: (reference: string) => void;
	readonly onDidRequestErrorAction?: (action: ChatTurnErrorAction) => void | Promise<void>;
	readonly onDidRequestLink?: (target: string) => void;
	readonly imageResourceLoader?: (resource: URI) => Promise<Blob>;
}

const textInputSelector = 'textarea, [role="textbox"], [contenteditable="true"]';
const focusableSelector = 'button, a, summary, textarea, audio, [role="textbox"], [tabindex="0"], [contenteditable="true"]';
const viewportMargin = 600;
const virtualOverscan = 1000;

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
	readonly toolExpansion?: readonly [string, ChatToolDisclosureState][];
	readonly thinkingExpansion?: readonly [string, boolean][];
	readonly turnChangesExpansion?: readonly string[];
	readonly focus: { readonly itemId: string; readonly index: number; readonly textInput?: boolean; } | undefined;
}

/** Renders the ordered user, Agent, reasoning, and tool items in one Chat pane. */
export class ChatListWidget extends DomWidget {
	// Disposed after the row collection so the final batch includes every row release.
	private readonly layoutTraceStore = this._register(new DisposableStore());
	private pendingDrag: ChatPendingDragController | undefined;
	private items: IChatListItem[] = [];
	private lastFocusedItemId: string | undefined;
	private readonly domNode: HTMLElement;
	private readonly scrollable: ScrollableElement;
	private readonly scrollToLatestButton: Button;
	private readonly scrollToLatestHostObserver = this._register(new MutableDisposable());
	private readonly transcript: HTMLDivElement;
	private working = false;
	private workingStatus: ChatWorkingProgressContentPart | undefined;
	private readonly stickyPrompt: PromptTimelineStickyHeader;
	private promptModel = new PromptTimelineModel<IChatListItem>([], id => this.promptTop(id));
	private readonly promptTimeline: PromptTimelineWidgetContrib | undefined;
	private pinnedPrompt: { readonly item: IChatListItem; readonly index: number; readonly total: number; } | undefined;
	private readonly layoutTrace: ChatLayoutTrace;
	private readonly renderedItems = this._register(new DisposableMap<string, ChatListItemRenderer>());
	private readonly imageBatches = this._register(new DisposableMap<string, RenderedImageBatch>());
	private imageBatchItems: readonly (readonly IChatListItem[])[] = [];
	private readonly classPrefix: string;
	private readonly accessibilityProvider = new ChatAccessibilityProvider();
	private readonly _onDidChangeContent = this._register(new Emitter<void>());
	private readonly _onDidChangeRenderedRows = this._register(new Emitter<void>());
	/** Remounting rows can change the DOM ranges without changing the transcript text. */
	public readonly onDidChangeFindableContent = Event.any(this._onDidChangeContent.event, this._onDidChangeRenderedRows.event);
	private readonly advisorExpansion = new Map<string, boolean>();
	private readonly contextExpansion = new Map<string, boolean>();
	private readonly thinkingExpansion = new Map<string, boolean>();
	private readonly toolExpansion = new Map<string, ChatToolDisclosureState>();
	private readonly turnChangesExpansion = new Set<string>();
	private visible = true;
	private shouldFollow = true;
	private pausedReplyScrollTop: number | undefined;
	private activeRequestEdit: { readonly id: string; readonly close: (restoreFocus: boolean) => boolean; } | undefined;
	private readonly refreshAfterRequestEdit = this._register(new RunOnceScheduler(() => this.render(this.items, this.working), 0));
	private readingPosition: ReadingAnchor | undefined;
	private layingOut = false;
	private readonly relayout = this._register(new RunOnceScheduler(() => { if (this.visible) this.layout(); }, 0));
	private pendingReadingPosition: { readonly top: number; readonly anchor: ReadingAnchor | undefined; } | undefined;
	private pendingItems: readonly IChatListItem[] | undefined;
	private readonly viewportObserver: IntersectionObserver | undefined;
	private readonly pendingViewportMeasurements = new Set<string>();
	private readonly refreshViewport = this._register(new RunOnceScheduler(() => this.refreshRowViewports(), 0));
	private virtualRows: ChatVirtualRows | undefined;
	private virtualPadding = 0;
	private virtualWindow: { readonly start: number; readonly end: number; } | undefined;
	private virtualPins: readonly number[] = [];
	private readonly virtualGaps = new Map<number, { readonly end: number; readonly element: HTMLDivElement; }>();
	private readonly rowResizeObserver: ResizeObserver | undefined;
	private selectionStart: string | undefined;
	private readonly refreshSelection = this._register(new RunOnceScheduler(() => this.refreshVirtualWindow(), 0));

	public get element(): HTMLElement { return this.domNode; }

	/** Places the list-owned control in the composer action row when the host supplies one. */
	public setScrollToLatestHost(host: HTMLElement | undefined, composerForm: HTMLElement | undefined, changesSummaryVisible?: IObservable<boolean>, overlapBoundary?: HTMLElement): void {
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
			const boundary = overlapBoundary?.getBoundingClientRect();
			const limit = boundary?.height ? Math.min(boundary.top, composer.top) : composer.top;
			// Measure from the unextended edge so observing the list cannot accumulate overlap.
			const appliedMargin = parseFloat(host.ownerDocument.defaultView!.getComputedStyle(this.element).marginBlockEnd);
			const overlap = Math.max(0, Math.round(limit - this.element.getBoundingClientRect().bottom - appliedMargin));
			const value = `${overlap}px`;
			if (this.element.style.getPropertyValue(overlapProperty) !== value) {
				const { top, maximumTop } = this.scrollable.state;
				this.element.style.setProperty(overlapProperty, value);
				this.element.classList.toggle('ash-chat-transcript-overlaps-composer', overlap > 0);
				// Hiding the jump button can change the maximum offset before the next
				// resize notification. Preserve the bottom even after a manual jump.
				if (this.visible && !this.layingOut && this.items.length && (this.shouldFollow || maximumTop - top <= 1)) {
					this.layout(undefined, false, true);
				}
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
			if (overlapBoundary) targets.push(overlapBoundary);
			if (host.parentElement) targets.push(host.parentElement);
			const resize = observeResize(targets, () => layout.schedule());
			// The jump button can hide its entire composer row on the last scroll event.
			// Correct the overlap before paint so the rail never extends into the input.
			const visibility = observeMutations(button, updateOverlap, { attributeFilter: ['hidden'] });
			const reserveSummarySpace = changesSummaryVisible && autorun(reader => {
				this.element.classList.toggle('ash-chat-transcript-has-changes-summary', changesSummaryVisible.read(reader));
			});
			this.scrollToLatestHostObserver.value = toDisposable(() => {
				resize.dispose();
				visibility.dispose();
				reserveSummarySpace?.dispose();
				layout.dispose();
				this.element.style.removeProperty(overlapProperty);
				this.element.classList.remove('ash-chat-transcript-overlaps-composer', 'ash-chat-transcript-has-changes-summary');
			});
		}
	}

	public getItems(): readonly IChatListItem[] { return this.items; }
	public getRowElement(id: string): HTMLElement | undefined { return this.renderedItems.get(id)?.element; }
	public getViewportAnchorItemId(): string | undefined { return this.readingAnchor()?.id; }

	public focusCodeBlock(reverse = false): void {
		if (this.isDisposed || !this.visible) { return; }
		const focused = this.getFocus();
		const item = focused && focused.type !== 'userMessage' ? focused : [...this.items].reverse().find(item => item.type === 'agentMessage');
		if (!item) { return; }
		this.reveal(item);
		const row = this.renderedItems.get(item.id);
		row?.revealCodeBlockContainer();
		const part: IChatContentPart | undefined = row?.toolPart ?? row?.markdownPart;
		const blocks = part?.codeblocks ?? [];
		if (!blocks.length) { return; }
		const document = this.element.ownerDocument;
		const current = blocks.findIndex(block => document.getElementById(block.elementId)?.contains(document.activeElement));
		const index = current < 0 ? (reverse ? blocks.length - 1 : 0) : (current + (reverse ? blocks.length - 1 : 1)) % blocks.length;
		blocks[index].focus();
	}

	public getFocus(): IChatListItem | undefined {
		return this.lastFocusedItemId ? this.itemById(this.lastFocusedItemId) : undefined;
	}

	public getFileTreeInfosForResponse(item: IChatListItem) { return this.renderedItems.get(item.id)?.getFileTreeInfos() ?? []; }
	public getLastFocusedFileTreeForResponse(item: IChatListItem) { return this.renderedItems.get(item.id)?.getLastFocusedFileTree(); }

	public getSibling(item: IChatListItem | undefined, type: 'next' | 'previous'): IChatListItem | undefined {
		if (!item) { return type === 'next' ? this.items[0] : this.items.at(-1); }
		const index = this.items.findIndex(candidate => candidate.id === item.id);
		return index < 0 ? undefined : this.items[index + (type === 'next' ? 1 : -1)];
	}

	public focus(item: IChatListItem): void {
		if (this.visible) { this.ensureRow(item.id)?.element.focus({ preventScroll: true }); }
	}

	public reveal(item: IChatListItem): void { this.revealItem(item.id); }

	public startEditing(requestId: string): void {
		if (this.visible) this.ensureRow(requestId)?.startEditing();
	}

	get isEditingRequest(): boolean { return this.activeRequestEdit !== undefined; }

	public cancelEditing(): boolean {
		return this.activeRequestEdit?.close(true) ?? false;
	}

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

	constructor(
		container: HTMLElement, private readonly options: ChatListWidgetOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IChatLayoutService chatLayoutService: IChatLayoutService,
		@ILoggerService loggerService: ILoggerService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
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
			if (this.refreshVirtualWindow()) return;
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
		const virtualizeHistoryFrom = options.virtualizeHistoryFrom;
		if (virtualizeHistoryFrom) {
			const Resize = this.transcript.ownerDocument.defaultView?.ResizeObserver;
			if (Resize) {
				this.rowResizeObserver = new Resize(() => { if (this.visible) this.relayout.schedule(); });
				this._register(toDisposable(() => this.rowResizeObserver?.disconnect()));
			}
			this._register(accessibilityService.onDidChangeScreenReaderOptimized(() => {
				if (this.virtualRows || this.items.length >= (virtualizeHistoryFrom.get() ?? Infinity)) this.render(this.items, this.working);
			}));
			this._register(addDisposableListener<PointerEvent>(this.transcript, 'pointerdown', event => {
				if (!this.virtualRows || event.button !== 0 || event.pointerType !== 'mouse') return;
				const target = event.target as HTMLElement;
				if (!target.closest(focusableSelector)) this.selectionStart = this.rowId(target);
			}));
			const endSelection = () => {
				if (!this.selectionStart) return;
				this.selectionStart = undefined;
				this.refreshSelection.schedule();
			};
			this._register(addDisposableListener(this.transcript.ownerDocument, 'pointerup', endSelection));
			this._register(addDisposableListener(this.transcript.ownerDocument, 'pointercancel', endSelection));
			this._register(addDisposableListener<KeyboardEvent>(this.transcript, 'keydown', event => this.navigateVirtualRows(event)));
		}
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
					const prompt = this.itemById(id);
					if (prompt) {
						this.focus(prompt);
						this.revealItem(id, undefined, true);
					}
				},
				changes: (id: string) => {
					const prompt = this.itemById(id);
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
		if (this.promptTimeline) {
			// Replacing a focused row can fire focusout before reconciliation updates the prompt model.
			const refreshTimelineFocus = this._register(new RunOnceScheduler(() => this.updateStickyPrompt(), 0));
			this._register(addDisposableListener(this.transcript, 'focusin', () => refreshTimelineFocus.schedule()));
			this._register(addDisposableListener(this.transcript, 'focusout', () => refreshTimelineFocus.schedule()));
		}
		const Observer = this.element.ownerDocument.defaultView?.IntersectionObserver;
		if (Observer) {
			// Keep text, actions and disclosure DOM available to native selection, find
			// and accessibility. Only the derived code-editor documents leave memory.
			this.viewportObserver = new Observer(entries => {
				const rows: ChatListItemRenderer[] = [];
				for (const entry of entries) {
					const row = this.renderedItems.get((entry.target as HTMLElement).dataset.itemId!);
					if (!row || row.element !== entry.target) continue;
					// Let completed replies establish their intrinsic height before CSS skips their contents.
					if (row.item.type === 'agentMessage' && entry.boundingClientRect.height > 0
						&& !row.element.classList.contains('ash-chat-item-measured')) {
						row.element.classList.add('ash-chat-item-measured');
					}
					row.inViewport = entry.isIntersecting;
					if (row.markdownPart) rows.push(row);
				}
				this.updateRowViewports(rows);
				this._onDidChangeRenderedRows.fire();
			}, { root: this.scrollable.scrollableElement, rootMargin: `${viewportMargin}px 0px` });
			this._register(toDisposable(() => this.viewportObserver?.disconnect()));
			this._register(addDisposableListener(this.transcript, 'focusout', () => this.refreshViewport.schedule()));
			this._register(addDisposableListener(this.element.ownerDocument, 'selectionchange', () => {
				this.refreshViewport.schedule();
				if (this.virtualRows) this.refreshSelection.schedule();
			}));
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
						localize('chat.turnError.limitHelp', 'After a provider limit error, use Tab to reach the available recovery actions. Try again asks Ash to continue after the failure. Choose another model opens the model picker.'),
						localize('chat.modelFeedback.rowHelp', 'On a completed reply, open More Actions and choose Give model feedback to open an editable report about the model used for that reply.'),
						localize('chat.response.voteHelp', 'In the Agents window, open More Actions on a completed Ash reply to mark it Good response or Bad response. The mark is saved in your Ash profile.'),
						getChatLinkPreviewAccessibilityHelp(),
						localize('chat.requestVersions.help', 'In Code, open the original request’s checkpoint actions and choose Run another version to run it again in a separate worktree. When both versions have finished and their Git snapshots are available, open More Actions on either reply and choose Compare results.'),
						...(this.options.openTurnChanges || this.options.getTurnChanges ? [localize('chat.turnChanges.help', 'When a completed reply has captured file changes, use Tab to reach its file count button. Press Enter or Space to open the before-and-after comparison for that turn.')] : []),
						...(this.options.getTurnChanges ? [localize('chat.turnChanges.filesHelp', 'Use Enter or Space on Changed files to expand the list. Tab to a file and press Enter to open its comparison.')] : []),
					].join('\n');
					return (this.promptTimeline ? localize('chat.promptTimeline.help', 'In the Agents window, hover over the left timeline to show prompts. Click a mark to jump to the prompt it previews. To open the list with the keyboard, focus Show prompts and press Enter. Use Up and Down Arrow, Home or End to move between prompts, and Left and Right Arrow to switch between a prompt and its change counts. Activate the prompt to jump to it or the counts to open that turn’s changes. In the ruler, activate a marker to see the same actions and expand Changed files to review an individual file. Escape closes the prompt list.') + '\n' : '') + localize('chat.stickyScroll.help', 'When a user prompt scrolls out of view, it stays at the top of the conversation. Tab to the pinned prompt and press Enter or Space to return to the original message.') + '\n' + localize('chat.memory.referenceHelp', 'When a reply cites a memory, use Open memory reference to read the excerpt and open its source conversation.') + '\n' + localize('chat.showAgentReplyTimestamps.help', 'In Settings, search for Show Agent reply timestamps to change whether reply times are shown.') + '\n' + localize('chat.requests.help', 'Click an editable request to edit its text in place. With the keyboard, Tab to its edit control and press Enter or Space. Enter inserts a line. Tab reaches Cancel and Send below the editor. Send or Ctrl or Command+Enter creates a new chat with the original context and attachments. Choose Cancel, click outside the editor, or press Escape to keep the original request and draft. Fork Conversation in the Command Palette copies the current history without sending. Use New Chat to start an empty conversation. These actions preserve the original conversation.') + '\n' + forkHelp + '\n' + localize('chat.remainingActions.help', 'Chat: Configure Tools edits the focused draft’s tool selection; Escape discards changes. Chat: Approve Tool Once and Chat: Decline Tool act only on the currently displayed approval. They never save an approval rule. Chat: Submit Requested Answers submits the current question form with its entered values; required answers must be filled. Use Ctrl or Command+Enter while the question form has focus. Chat: Retry Failed Request repeats an available failed request through its original retry policy. Chat: Copy Final Response copies the latest completed assistant reply without speaker labels or streaming text. Chat: Next Code Block and Chat: Previous Code Block move focus through the current or latest response’s code blocks and wrap at the ends. Use Ctrl or Command+Alt+Page Down or Page Up in Chat. Chat: Export Conversation Transcript saves a frozen backend text snapshot, including voice transcripts, tool call summaries with inputs and errors, and partial markers. Tool output, result attachments and internal reasoning are excluded. Chat: Open Saved Transcript (Read-Only) opens a supported saved document in a read-only editor; it does not restore or execute a conversation. These commands keep the unsent draft.') + '\n' + localize('chat.pickers.commandHelp', 'Use Chat: Open Model Picker, Chat: Open Mode or Agent Picker, or Chat: Open Permission Picker in the Command Palette to configure the most recently focused composer. Model and mode pickers also open with {0} and {1}. Fixed-mode inputs keep the mode picker hidden. Escape closes a picker. Opening or cancelling keeps the draft and attachments without sending. Switching conversations retires pending selections and permission confirmations.', '<keybinding:workbench.action.chat.openModelPicker>', '<keybinding:workbench.action.chat.openModePicker>') + '\n' + localize('chat.execution.help', 'Chat: Send Message uses the current draft, attachments and submission policy. Chat: Add Message to Queue waits for the current request to finish; Chat: Steer with Message explicitly targets it. When idle, both send normally. Explicit steering rejects a different mode, Skill or task type. Queue and steering actions do not run slash commands. Failed submissions restore the draft if it has not been edited again. Use {0} to stop the focused task while keeping unsent text. Stopping remains available for running work when AI features are disabled.', '<keybinding:workbench.action.chat.cancel>') + '\n' + localize('chat.queue.manageHelp', 'Use Chat: Edit Queued Message, Chat: Remove Queued Message or Chat: Send Queued Message Immediately in the Command Palette, then select a message in queue order. Editing pauses that message and preserves attached inputs and your unsent draft. Enter keeps the edited message’s queue or steering action; Alt+Enter uses the other action. Ctrl or Command+Enter saves; Escape restores a previously pending message at its original position. Previously paused or failed messages remain paused when editing is cancelled. A changed revision requires choosing the message again. Send Immediately moves the original message to the front and stops the current task before running it. Remove All Queued Messages removes the captured revisions and keeps messages added while the action runs.') + '\n' + localize('chat.navigation.help', 'Use {0} to focus the latest response and {1} to return to the last focused message. Use {2} and {3} to move between user prompts without wrapping. Navigation includes loaded messages; load earlier messages to reach older prompts. On macOS, the input-to-list shortcut applies only on the first visual input line. Quick Chat reverses the input-to-list shortcut direction. Use {4} to focus a pending confirmation or return to the input. Focusing never accepts or declines a request, sends a message or changes the draft.', '<keybinding:chat.action.focus>', '<keybinding:workbench.chat.action.focusLastFocused>', '<keybinding:workbench.action.chat.previousUserPrompt>', '<keybinding:workbench.action.chat.nextUserPrompt>', '<keybinding:workbench.action.chat.focusConfirmation>') + '\n' + localize('chat.find.commandsHelp', 'Use {0} to find text in this conversation. Find includes complete code blocks and continues through earlier history without sending or changing the draft. Use the result controls to navigate; Escape closes Find and restores focus.', '<keybinding:workbench.action.chat.find>') + '\n' + localize('chat.commands.help', 'Use Focus Chat Input in the Command Palette to return to the most recently focused Chat input. From a conversation, use {0} to return to its input. Chat: Copy Conversation in the Command Palette copies all text messages and voice transcripts, including earlier history. Markdown is preserved. Export Transcript in the conversation title menu saves a JSON snapshot of the conversation. Draft text is kept in the input.', '<keybinding:workbench.action.chat.focusInput>') + '\n' + localize('chat.naming.help', 'New conversations take an initial name from the first message. Use Chat: Rename Conversation in the Command Palette to set a name. Enter saves it and Escape cancels. Manual names are kept when automatic naming finishes later.') + '\n' + localize('chat.history.paginationHelp', 'Chat initially shows recent messages. Use Tab to reach Load earlier messages, then Enter or Space to load another page. Loading preserves your draft, active approvals and reading position. If it fails, use Retry earlier messages. Live messages remain available while older history loads.') + '\n' + localize('chat.transcript.help', 'Chat responses\nWith a Speech extension, use Read aloud on a completed response. The same button stops reading; Escape also stops it. Hiding or removing the response cancels reading. Use Stop reading aloud in the Command Palette after moving focus elsewhere. Use Tab and Shift+Tab to reach message copy actions, response links, code block actions and tool summaries. Copy message preserves Markdown and copies internal resource links as code labels. Copying a selection also replaces internal links with their visible labels. Paste a copied message into a rich text editor to keep inline diagrams and their captions. Tool summaries describe the activity and its current result state. Press Enter or Space on a tool summary to inspect its source and execution target. Input, standard output, standard error and result each have a separate summary; press Enter or Space to expand or collapse them. Tab to an expanded text region and use the arrow keys to scroll long output. Tool text is displayed literally. Code block actions copy the complete source, insert it into the active editor, or open it in a new unsaved file. Use context summaries to inspect the exact text attached to a request. Use resource summaries to inspect returned data and Open resource for a read-only preview. To download a file from a reply, focus its file name link and press Enter. Use Load image or Load audio to read a stored attachment. Open image or Open audio opens its original bytes in a read-only editor. Opening audio pauses the transcript player. Open interactive view loads a declared MCP App; use Tab or Shift+Tab to reach its controls and Close interactive view to return focus. Streaming updates and provider corrections keep code selections, keyboard focus and expansion. When Automatically follow new replies is enabled in Chat settings, returning to the bottom resumes following. Scrolling up or editing a message pauses following. While reading earlier messages, use Scroll to Latest to jump to the bottom. Failed calls show an error; a finished turn without a result is never shown as successful. Use <keybinding:editor.action.accessibleView> to read the transcript as plain text, including collapsed tool details. Closing this view returns focus to the response.') + '\n' + localize('chat.media.copyHelp', 'For a loaded local image, use Tab to reach Copy image and press Enter or Space to copy it to the clipboard.') + '\n' + localize('chat.turnChanges.previewHelp', 'In a reply, expand Changed files to find its file actions. Preview changes opens a read-only comparison in the transcript. Open changes opens the full Changes editor.') + '\n' + localize('chat.markdown.tableScrollHelp', 'Use Tab to reach the download action for a reply image and Export table as CSV for a response table. Use Left or Right Arrow to scroll a focused table. On a wide table, activate Expand table to open a larger preview. Press Escape to return to the Expand table button. Find in Chat scrolls the table to the matching cell.') + '\n' + localize('chat.thinking.help', 'Reasoning starts collapsed. Press Enter or Space on its summary to expand or collapse it. Streaming updates and completion keep your expansion and keyboard focus. Code block navigation expands the matching reasoning when needed. The accessible transcript includes reasoning even while collapsed.') + '\n' + localize('chat.imageGeneration.help', 'Generated images appear outside the tool details. Use Open image for a read-only preview of the original image, or Download to save it. Progress ends with a reveal after decoding; reduced motion and high contrast show the result directly. Failure or stopping ends progress, and restored history does not replay generation animations.') + '\n' + localize('chat.response.feedbackHelp', 'Completed IDE Chat responses offer Helpful. Press Enter or Space to save a personal helpful mark for that response; reopening Chat retains it. Feedback stays in the current Ash profile and is not sent to the model provider or used to change the response. Choose Helpful response animation in Settings to change or disable the effect. Reduced motion also disables the animation.') + '\n' + localize('chat.subagent.help', 'A delegated agent card reports the latest state and any returned summary. Tab to Open conversation or Open to the side and press Enter or Space to inspect the child conversation.') + '\n' + localize('chat.typography.help', 'In Settings, open Chat, then Appearance to change the message font and text size, including Markdown and links. Message input and code blocks have separate font settings. Changes keep your draft and reading position.');
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
		}, () => this.configurationService.getValue<boolean>(ChatConfiguration.ShowAgentReplyTimestamps) !== false)));
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
			if (event.affectsConfiguration(ChatConfiguration.ShowAgentReplyTimestamps)) {
				for (const [, row] of this.renderedItems) {
					if (row.item.type === 'agentMessage') { row.updateMessageTime(); }
				}
				this._onDidChangeContent.fire();
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
		if (virtualizeHistoryFrom) {
			this._register(autorun(reader => {
				const threshold = virtualizeHistoryFrom.read(reader) ?? Infinity;
				if (this.virtualRows || this.items.length >= threshold) this.render(this.items, this.working);
			}));
		}
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

	render(items: readonly IChatListItem[], working = false): void {
		this.items = [...items];
		this.working = working;
		if (!this.visible) {
			// The model continues receiving events. Hidden presentation consumes its
			// latest projection once on show instead of parsing every intermediate one.
			this.pendingItems = this.items;
			return;
		}
		this.reconcile(items);
	}

	/** Updates the one existing row identified by a text-only model notification. */
	public tryQueueStreamingResponse({ item, previousText }: ChatStreamingResponseUpdate): boolean {
		if (!this.visible) return false;
		const row = this.renderedItems.get(item.id);
		if (row?.item.text !== previousText) return false;
		const index = findLastIdx(this.items, candidate => candidate.id === item.id);
		if (index < 0 || !row.tryQueuePlainResponse(item)) return false;
		this.items[index] = item;
		return true;
	}

	setBusy(busy: boolean): void {
		const value = String(busy);
		if (this.transcript.getAttribute('aria-busy') !== value) this.transcript.setAttribute('aria-busy', value);
	}

	private reconcile(items: readonly IChatListItem[], viewportOnly = false, top = this.scrollable.state.top): void {
		let needsLayout = false;
		let anchor: ReadingAnchor | undefined;
		const beforeLayout = () => {
			if (needsLayout) return;
			needsLayout = true;
			if (this.visible && !viewportOnly) {
				this.captureFollowState();
				anchor = this.shouldFollow ? undefined : this.readingPosition;
			} else if (this.visible && !this.shouldFollow) {
				anchor = this.readingPosition;
			}
		};
		if (!viewportOnly) {
			const useVirtualRows = items.length >= (this.options.virtualizeHistoryFrom?.get() ?? Infinity) && !this.accessibilityService.isScreenReaderOptimized();
			this.imageBatchItems = getImageGenerationBatches(items);
			const changedVirtualMode = useVirtualRows !== (this.virtualRows !== undefined);
			if (useVirtualRows || this.virtualRows) beforeLayout();
			if (useVirtualRows) {
				this.virtualRows ??= new ChatVirtualRows();
				this.virtualRows.setItems(items);
				this.virtualPadding = this.readVirtualPadding();
			} else {
				this.virtualRows = undefined;
				this.selectionStart = undefined;
				this.rowResizeObserver?.disconnect();
			}
			this.virtualWindow = undefined;
			if (changedVirtualMode) {
				this.element.classList.toggle('ash-chat-transcript-virtualized', useVirtualRows);
				// Mounting old history must not announce it as a new reply.
				this.transcript.setAttribute('aria-live', useVirtualRows ? 'off' : 'polite');
			}
			this.promptModel = new PromptTimelineModel(items.filter(item => item.type === 'userMessage'), id => this.promptTop(id));
			if (this.virtualRows) {
				const saved = this.pendingReadingPosition?.anchor ?? anchor;
				const index = saved && this.virtualRows.indexOf(saved.id);
				const height = this.scrollable.scrollableElement.clientHeight || 800;
				top = this.shouldFollow ? Math.max(0, this.virtualRows.size - height)
					: saved && typeof index === 'number' ? this.virtualRows.positionAt(index) + this.virtualPadding - saved.viewportTop : top;
			}
		}
		const entries = this.renderEntries(items, top);
		const active = this.element.ownerDocument.activeElement;
		const focusedRow = this.lastFocusedItemId ? this.renderedItems.get(this.lastFocusedItemId) : undefined;
		const focusedReferenceId = isHTMLElement(active) ? active.dataset.chatReferenceId : undefined;
		const focusedActionRowId = focusedRow?.element.contains(active)
			&& (focusedReferenceId || focusedRow.item.requestSource || focusedRow.item.requestEdit || focusedRow.item.requestHasVersions
				|| focusedRow.item.queueTarget || focusedRow.item.historyRedoTarget || focusedRow.item.turnChanges)
			? focusedRow.item.id : undefined;
		const focusedActionId = focusedActionRowId ? active?.closest<HTMLElement>('[data-action-id]')?.dataset.actionId : undefined;
		const queueReorderFocused = focusedActionRowId && isHTMLElement(active) && active.dataset.chatQueueReorder === 'true';
		const imageFocus = isHTMLElement(active) && [...this.imageBatches].some(([, entry]) => entry.part.domNode.contains(active)) ? active : undefined;
		let changed = needsLayout;
		const ids = new Set(entries.flatMap(entry => 'text' in entry ? [entry.id] : []));
		for (const [id, row] of this.renderedItems) {
			if (ids.has(id)) continue;
			beforeLayout();
			if (this.virtualRows?.indexOf(id) !== undefined) this.rememberDisclosures(id, row);
			this.viewportObserver?.unobserve(row.element);
			this.rowResizeObserver?.unobserve(row.element);
			this.renderedItems.deleteAndDispose(id);
			this.pendingViewportMeasurements.delete(id);
			changed = true;
		}
		let next: ChildNode | null = this.transcript.firstChild;
		for (const item of entries) {
			if (!('text' in item)) {
				if (item !== next) {
					beforeLayout();
					this.transcript.insertBefore(item, next);
					changed = true;
				}
				next = item.nextSibling;
				continue;
			}
			let row = this.renderedItems.get(item.id);
			if (row && this.virtualRows && !viewportOnly) this.rowResizeObserver?.observe(row.element);
			const update = row?.update(item, beforeLayout);
			if (row && update === 'unchanged') {
				if (row.element !== next) {
					beforeLayout();
					this.transcript.insertBefore(row.element, next);
					changed = true;
				}
				next = row.element.nextSibling;
				continue;
			}
			changed = true;
			if (!row || update === 'replace') {
				beforeLayout();
				if (row?.element === next) next = row.element.nextSibling;
				if (row) {
					if (this.virtualRows) this.rememberDisclosures(item.id, row);
					this.viewportObserver?.unobserve(row.element);
					this.rowResizeObserver?.unobserve(row.element);
				}
				// Retire the previous row before its replacement starts attachment work.
				this.renderedItems.deleteAndDispose(item.id);
				if (item.queueTarget && !this.pendingDrag) {
					this.pendingDrag = this._register(this.instantiationService.createInstance(
						ChatPendingDragController, this.transcript,
						() => this.items.flatMap(item => item.queueTarget ? [item.queueTarget] : []),
						() => this.visible,
					));
				}
				row = this.renderedItems.set(item.id, this.instantiationService.createInstance(ChatListItemRenderer, item, this.element.ownerDocument, {
					...this.options,
					onDidRequestEdit: this.options.onDidRequestEdit ?? (requestId => this.startEditing(requestId)),
					canEditRequest: this.options.canEditRequest ?? (() => true),
					cancelRequestEdit: () => this.cancelEditing(),
					refreshRequestAfterEdit: () => this.refreshAfterRequestEdit.schedule(),
					classPrefix: this.classPrefix,
					deferCodeBlockModels: !!this.viewportObserver,
					synchronousInitialRender: this.virtualRows !== undefined && !item.transient,
					isVisible: () => this.visible,
					advisorExpansion: this.advisorExpansion,
					contextExpansion: this.contextExpansion,
					thinkingExpansion: this.thinkingExpansion,
					turnChangesExpansion: this.turnChangesExpansion,
					pendingDrag: this.pendingDrag,
					onDidChangeHeight: () => this.relayout.schedule(),
					beginRequestEdit: (close: (restoreFocus: boolean) => boolean) => {
						if (this.activeRequestEdit && !this.activeRequestEdit.close(false)) return undefined;
						const edit = this.activeRequestEdit = { id: item.id, close };
						this.shouldFollow = false;
						this.readingPosition = this.readingAnchor();
						return toDisposable(() => {
							if (this.activeRequestEdit === edit) this.activeRequestEdit = undefined;
						});
					},
					onWillCloseRequestEditor: ({ heightChanges, sent }: { readonly heightChanges: boolean; readonly sent: boolean; }) => {
						const anchor = heightChanges ? this.readingAnchor() : undefined;
						return () => {
							if (heightChanges) this.layout(anchor, false);
							const viewport = this.scrollable.scrollableElement;
							const top = viewport.scrollTop;
							this.pausedReplyScrollTop = sent ? undefined : top;
							if (sent) this.updateReplyFollowing(top, viewport.scrollHeight - viewport.clientHeight);
							else this.readingPosition = this.readingAnchor();
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
				const toolExpansion = this.toolExpansion.get(item.id);
				if (toolExpansion) row.toolPart?.restoreDisclosure(toolExpansion);
				this.viewportObserver?.observe(row.element);
				if (this.virtualRows) this.rowResizeObserver?.observe(row.element);
				if (this.viewportObserver) this.pendingViewportMeasurements.add(item.id);
			}
			if (this.viewportObserver && row.markdownPart && (update !== 'queued' || row.element !== next)) this.pendingViewportMeasurements.add(item.id);
			if (row.element !== next) {
				beforeLayout();
				this.transcript.insertBefore(row.element, next);
			}
			next = row.element.nextSibling;
		}
		changed = this.renderImageBatches(viewportOnly, beforeLayout) || changed;
		if (this.working !== (this.workingStatus?.domNode.hidden === false)) {
			beforeLayout();
			this.renderWorkingStatus();
			changed = true;
		}
		// Reparenting a retained gallery can blur its button. Restore only that button,
		// and never replace focus deliberately moved elsewhere by a render listener.
		if (imageFocus?.isConnected && this.element.ownerDocument.activeElement === this.element.ownerDocument.body) {
			imageFocus.focus({ preventScroll: true });
		}
		if (focusedActionRowId && (!active?.isConnected || queueReorderFocused) && this.element.ownerDocument.activeElement === this.element.ownerDocument.body) {
			const row = this.renderedItems.get(focusedActionRowId);
			const replacement = queueReorderFocused ? row?.element.querySelector<HTMLElement>('[data-chat-queue-reorder]:not([hidden])')
				: focusedReferenceId
					? Array.from(row?.element.querySelectorAll<HTMLButtonElement>('[data-chat-reference-id]') ?? [])
						.find(button => button.dataset.chatReferenceId === focusedReferenceId)
					: focusedActionId && row && Array.from(row.element.querySelectorAll<HTMLButtonElement>('[data-action-id] > button'))
						.find(button => button.parentElement?.dataset.actionId === focusedActionId && !button.disabled);
			if (replacement) replacement.focus({ preventScroll: true });
			else if (row) this.focus(row.item);
			else this.focusReadingPosition();
		}
		if (!viewportOnly) {
			const hasItem = (id: string) => this.virtualRows ? this.virtualRows.indexOf(id) !== undefined : ids.has(id);
			if (this.lastFocusedItemId && !hasItem(this.lastFocusedItemId)) this.lastFocusedItemId = undefined;
			for (const id of this.contextExpansion.keys()) if (!hasItem(id)) this.contextExpansion.delete(id);
			for (const id of this.advisorExpansion.keys()) if (!hasItem(id)) this.advisorExpansion.delete(id);
			for (const id of this.thinkingExpansion.keys()) if (!hasItem(id)) this.thinkingExpansion.delete(id);
			for (const id of this.toolExpansion.keys()) if (!hasItem(id)) this.toolExpansion.delete(id);
			for (const id of this.turnChangesExpansion) if (!hasItem(id)) this.turnChangesExpansion.delete(id);
		}
		// Reconciliation can temporarily shorten the DOM scroll range. Keep the position
		// captured before moving retained widgets instead of interpreting that clamp as user input.
		if (changed) {
			// A queued Markdown snapshot reports its own geometry after committing DOM.
			if (needsLayout) {
				if (this.visible) this.layout(anchor, false);
				if (this.pendingViewportMeasurements.size) this.refreshRowViewports();
			}
			if (viewportOnly) this._onDidChangeRenderedRows.fire();
			else this._onDidChangeContent.fire();
		} else if (this.visible) {
			this.renderPromptTimeline();
		}
	}

	private rememberDisclosures(id: string, row: ChatListItemRenderer): void {
		if (row.context) this.contextExpansion.set(id, row.context.disclosure.open);
		if (row.thinkingPart) this.thinkingExpansion.set(id, row.thinkingPart.domNode.open);
		const tool = row.toolPart?.disclosureState;
		if (tool?.userInteracted) this.toolExpansion.set(id, tool);
	}

	private itemById(id: string): IChatListItem | undefined {
		const index = this.virtualRows?.indexOf(id);
		return index === undefined ? this.renderedItems.get(id)?.item : this.items[index];
	}

	private rowId(node: Node | null): string | undefined {
		const element = isHTMLElement(node) ? node : node?.parentElement;
		const row = element?.closest<HTMLElement>('.ash-chat-item[data-item-id]');
		return row?.parentElement === this.transcript ? row.dataset.itemId : undefined;
	}

	private readVirtualPadding(): number {
		return parseFloat(this.transcript.ownerDocument.defaultView!.getComputedStyle(this.transcript).paddingTop) || 0;
	}

	private windowAt(rows: ChatVirtualRows, top: number): { readonly start: number; readonly end: number; } {
		const start = top - this.virtualPadding;
		const end = start + (this.scrollable.state.height || this.scrollable.scrollableElement.clientHeight || 800);
		const window = this.virtualWindow;
		// Keep the existing buffer until the viewport approaches its edges.
		if (window && (window.start === 0 || rows.positionAt(window.start) <= start - virtualOverscan / 3)
			&& (window.end === rows.count || rows.positionAt(window.end) >= end + virtualOverscan / 3)) return window;
		return {
			start: Math.min(rows.count - 1, rows.indexAt(start - virtualOverscan)),
			end: Math.min(rows.count, rows.indexAt(end + virtualOverscan) + 1),
		};
	}

	private pinnedRows(rows: ChatVirtualRows, window: { readonly start: number; readonly end: number; }): number[] {
		const document = this.transcript.ownerDocument;
		const indexOf = (node: Node | null) => {
			const id = this.rowId(node);
			return id ? rows.indexOf(id) : undefined;
		};
		const pins = new Set<number>();
		const focused = indexOf(document.activeElement);
		if (focused !== undefined) pins.add(focused);
		const editing = this.activeRequestEdit && rows.indexOf(this.activeRequestEdit.id);
		if (editing !== undefined) pins.add(editing);
		for (const [id, row] of this.renderedItems) {
			if (row.hasActivePlayback || row.toolPart?.keepMounted) {
				const index = rows.indexOf(id);
				if (index !== undefined) pins.add(index);
			}
		}
		const selection = document.getSelection();
		const dragStart = this.selectionStart === undefined ? undefined : rows.indexOf(this.selectionStart);
		const anchor = dragStart ?? (!selection?.isCollapsed ? indexOf(selection?.anchorNode ?? null) : undefined);
		const extent = indexOf(selection?.focusNode ?? null);
		if (anchor !== undefined) {
			// A native drag can reach the edge before Chromium updates the selection end.
			const start = Math.min(anchor, extent ?? anchor, dragStart === undefined ? anchor : window.start);
			const end = Math.max(anchor, extent ?? anchor, dragStart === undefined ? anchor : window.end - 1);
			for (let i = start; i <= end; i++) pins.add(i);
		}
		return [...pins].filter(index => index < window.start || index >= window.end).sort((a, b) => a - b);
	}

	private refreshVirtualWindow(top = this.scrollable.state.top): boolean {
		const rows = this.virtualRows;
		if (!rows || !this.visible || this.layingOut) return false;
		const window = this.windowAt(rows, top);
		const pins = this.pinnedRows(rows, window);
		if (window === this.virtualWindow && pins.length === this.virtualPins.length && pins.every((value, i) => value === this.virtualPins[i])) return false;
		this.reconcile(this.items, true, top);
		return true;
	}

	private renderEntries(items: readonly IChatListItem[], top: number): readonly (IChatListItem | HTMLDivElement)[] {
		const rows = this.virtualRows;
		const gaps = new Set<number>();
		let entries: readonly (IChatListItem | HTMLDivElement)[] = items;
		if (rows) {
			const window = this.virtualWindow = this.windowAt(rows, top);
			const pins = this.virtualPins = this.pinnedRows(rows, window);
			const mounted = [
				...pins.filter(index => index < window.start),
				...Array.from({ length: window.end - window.start }, (_, index) => window.start + index),
				...pins.filter(index => index >= window.end),
			];
			const result: (IChatListItem | HTMLDivElement)[] = [];
			const addGap = (start: number, end: number) => {
				if (start === end) return;
				const element = this.virtualGaps.get(start)?.element ?? h(this.transcript.ownerDocument, 'div');
				element.setAttribute('aria-hidden', 'true');
				element.className = 'ash-chat-transcript-gap';
				element.style.height = `${rows.positionAt(end) - rows.positionAt(start)}px`;
				this.virtualGaps.set(start, { end, element });
				gaps.add(start);
				result.push(element);
			};
			let next = 0;
			for (const index of mounted) {
				addGap(next, index);
				result.push(items[index]);
				next = index + 1;
			}
			addGap(next, items.length);
			entries = result;
		}
		for (const [start, gap] of this.virtualGaps) {
			if (gaps.has(start)) continue;
			gap.element.remove();
			this.virtualGaps.delete(start);
		}
		return entries;
	}

	private measureVirtualRows(): void {
		const rows = this.virtualRows;
		if (!rows || !this.scrollable.scrollableElement.clientHeight) return;
		this.virtualPadding = this.readVirtualPadding();
		const measured = [...this.renderedItems].flatMap(([id, row]) => {
			const height = row.element.getBoundingClientRect().height;
			const margin = parseFloat(this.transcript.ownerDocument.defaultView!.getComputedStyle(row.element).marginBottom) || 0;
			return height > 0 ? [{ id, height: height + margin }] : [];
		});
		if (!rows.measure(measured)) return;
		for (const [start, { end, element }] of this.virtualGaps) {
			element.style.height = `${rows.positionAt(end) - rows.positionAt(start)}px`;
		}
	}

	private ensureRow(id: string): ChatListItemRenderer | undefined {
		const existing = this.renderedItems.get(id);
		const rows = this.virtualRows;
		const index = rows?.indexOf(id);
		if (existing || !rows || index === undefined || !this.visible) return existing;
		this.moveVirtualViewport(rows.positionAt(index) + this.virtualPadding);
		return this.renderedItems.get(id);
	}

	private moveVirtualViewport(top: number): void {
		this.layingOut = true;
		try {
			this.scrollable.layout();
			this.scrollable.scrollTo(0, top);
		} finally { this.layingOut = false; }
		this.updateReplyFollowing(this.scrollable.state.top, this.scrollable.state.maximumTop);
		this.refreshVirtualWindow();
	}

	private navigateVirtualRows(event: KeyboardEvent): void {
		if (event.key !== 'Tab' || event.defaultPrevented || !this.virtualRows) return;
		const id = this.rowId(event.target as Node);
		const row = id && this.renderedItems.get(id);
		if (!row) return;
		const reverse = event.shiftKey;
		const next = reverse ? row.element.previousElementSibling : row.element.nextElementSibling;
		if (!next?.classList.contains('ash-chat-transcript-gap')) return;
		const controls = this.tabbableControls(row.element);
		if (controls.length && (reverse ? controls[0] : controls.at(-1)) !== event.target) return;
		const adjacent = this.getSibling(row.item, reverse ? 'previous' : 'next');
		if (!adjacent) return;
		event.preventDefault();
		this.reveal(adjacent);
		const element = this.renderedItems.get(adjacent.id)?.element;
		if (!element) return;
		const targets = this.tabbableControls(element);
		((reverse ? targets.at(-1) : targets[0]) ?? element).focus({ preventScroll: true });
	}

	private tabbableControls(row: HTMLElement): HTMLElement[] {
		return [...row.querySelectorAll<HTMLElement>(focusableSelector)].filter(control => control.tabIndex >= 0
			&& !control.matches(':disabled') && control.getClientRects().length > 0);
	}

	private renderWorkingStatus(): void {
		const progress = this.workingStatus ??= this._register(this.instantiationService.createInstance(
			ChatWorkingProgressContentPart, this.transcript, this.element, this.scrollable.scrollableElement,
		));
		progress.setVisible(this.visible);
		progress.setWorking(this.working);
	}

	private renderImageBatches(viewportOnly: boolean, beforeLayout: () => void): boolean {
		const used = new Set<string>();
		let changed = false;
		for (const batch of this.imageBatchItems) {
			const call = batch[0].toolInvocation!;
			const host = this.renderedItems.get(batch.at(-1)!.id)?.toolPart?.domNode;
			const members = new Set(batch.map(item => item.id));
			// Match surviving members so extending history or removing a batch's first
			// row does not create another media owner or read the same attachments again.
			const retained = [...this.imageBatches].find(([key, entry]) => !used.has(key)
				&& entry.turnId === call.call.turnId && entry.members.some(id => members.has(id)));
			const key = retained?.[0] ?? batch[0].id;
			let entry = retained?.[1];
			if (!entry) {
				if (!host) continue;
				beforeLayout();
				const part = this.instantiationService.createInstance(ChatImageGenerationBatchPart, this.element.ownerDocument);
				entry = this.imageBatches.set(key, Object.assign(new DisposableStore(), { part, turnId: call.call.turnId, members: [] as readonly string[] }));
				entry.add(part);
				entry.add(part.onDidChangeHeight(() => { this.relayout.schedule(); this._onDidChangeContent.fire(); }));
				changed = true;
			}
			used.add(key);
			entry.members = [...members];
			const parent = entry.part.domNode.parentElement;
			if (!host) {
				// Keep the visited batch's loaded media, but release its detached row.
				if (parent) {
					entry.part.setVisible(false);
					entry.part.domNode.remove();
				}
				continue;
			}
			if (parent !== host) {
				beforeLayout();
				host.append(entry.part.domNode);
				entry.part.setVisible(this.visible);
				changed = true;
			}
			if (!viewportOnly || parent !== host) entry.part.render(batch);
		}
		for (const key of this.imageBatches.keys()) {
			if (!used.has(key)) { beforeLayout(); this.imageBatches.deleteAndDispose(key); changed = true; }
		}
		return changed;
	}

	setVisible(visible: boolean): void {
		// A replacement can already be visible and still have a reading position to restore.
		if (this.visible === visible && !(visible && this.pendingReadingPosition)) return;
		if (!visible) {
			this.pendingDrag?.cancelDrag();
			this.relayout.cancel();
			this.refreshViewport.cancel();
			this.refreshSelection.cancel();
			this.selectionStart = undefined;
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
		this.workingStatus?.setVisible(visible);
		for (const [, entry] of this.imageBatches) { entry.part.setVisible(visible && this.transcript.contains(entry.part.domNode)); }
		if (!visible) {
			this.updateStickyPrompt();
			this.updateScrollToLatestVisibility();
			this.renderPromptTimeline();
		}
		for (const [, row] of this.renderedItems) {
			row.setVisible(visible);
		}
		if (visible) {
			if (this.pendingReadingPosition) {
				const { top, anchor } = this.pendingReadingPosition;
				const index = anchor && this.virtualRows?.indexOf(anchor.id);
				if (this.virtualRows && !this.shouldFollow) {
					const target = anchor && typeof index === 'number' ? this.virtualRows.positionAt(index) + this.virtualPadding - anchor.viewportTop : top;
					this.moveVirtualViewport(target);
				} else {
					this.layingOut = true;
					try {
						this.scrollable.layout();
						this.scrollable.scrollTo(0, top);
					} finally { this.layingOut = false; }
				}
			}
			this.layout(this.pendingReadingPosition?.anchor, false);
			this.pendingReadingPosition = undefined;
			this.refreshVirtualWindow();
			this.refreshRowViewports();
		}
	}

	private refreshRowViewports(): void {
		if (!this.visible) return;
		const viewport = this.pendingViewportMeasurements.size ? this.scrollable.scrollableElement.getBoundingClientRect() : undefined;
		const rows: ChatListItemRenderer[] = [];
		for (const [id, row] of this.renderedItems) {
			if (viewport && this.pendingViewportMeasurements.delete(id)) {
				const bounds = row.element.getBoundingClientRect();
				row.inViewport = viewport.height > 0 && bounds.bottom > viewport.top - viewportMargin && bounds.top < viewport.bottom + viewportMargin;
			}
			if (row.markdownPart) rows.push(row);
		}
		this.updateRowViewports(rows);
	}

	public setFindVisible(visible: boolean): void {
		const height = visible ? this.element.querySelector<HTMLElement>('.ash-chat-find')?.getBoundingClientRect().height ?? 0 : 0;
		const padding = visible ? `${height + 16}px` : '';
		if (this.transcript.style.paddingTop === padding) { return; }
		const anchor = this.readingAnchor();
		// The first message needs real scroll space below the floating Find controls.
		this.transcript.style.paddingTop = padding;
		if (this.visible) { this.layout(anchor, false); }
	}

	public revealItem(id: string, target?: { readonly top: number; readonly bottom: number; }, alignToTop = false): void {
		const row = this.ensureRow(id);
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
		this.refreshVirtualWindow();
	}

	private updateRowViewports(rows: readonly ChatListItemRenderer[]): void {
		if (!rows.length) return;
		const document = this.element.ownerDocument;
		const active = document.activeElement;
		const selection = document.getSelection();
		// Read the selection once after recording all measured rows. Selection
		// reads can flush pending styles before any code editors are activated.
		const ranges = selection && !selection.isCollapsed
			? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
			: [];
		// Keyboard focus and a native selection pin their response even if a user
		// scrolls it out of view; scrolling must not interrupt editing or copying.
		for (const row of rows) {
			row.markdownPart?.setViewportVisible(row.inViewport || row.element.contains(active) || ranges.some(range => range.intersectsNode(row.element)));
		}
	}

	/** Captures presentation state without taking ownership of conversation data. */
	public getViewState(): ChatListViewState {
		if (this.visible) this.captureFollowState();
		const active = this.element.ownerDocument.activeElement;
		let focus: ChatListViewState['focus'];
		const contextExpansion = new Map(this.contextExpansion);
		const thinkingExpansion = new Map(this.thinkingExpansion);
		const toolExpansion = new Map(this.toolExpansion);
		for (const [itemId, row] of this.renderedItems) {
			if (row.context) contextExpansion.set(itemId, row.context.disclosure.open);
			if (row.thinkingPart) thinkingExpansion.set(itemId, row.thinkingPart.domNode.open);
			if (row.toolPart) toolExpansion.set(itemId, row.toolPart.disclosureState);
			if (!row.element.contains(active)) continue;
			if (active === row.element) { focus = { itemId, index: -1 }; continue; }
			// Editor scrollbars appear after measurement; their controls must not shift the
			// remembered input ordinal while a replacement editor is still being laid out.
			const textInput = active?.matches(textInputSelector) === true;
			const index = [...row.element.querySelectorAll(textInput ? textInputSelector : focusableSelector)].indexOf(active!);
			if (index >= 0) focus = { itemId, index, ...(textInput ? { textInput: true } : {}) };
		}
		return {
			visible: this.visible,
			lastFocusedItemId: this.lastFocusedItemId,
			shouldFollow: this.shouldFollow,
			top: this.pendingReadingPosition?.top ?? this.scrollable.state.top,
			anchor: this.pendingReadingPosition?.anchor ?? (this.visible && !this.shouldFollow ? this.readingPosition : undefined),
			advisorExpansion: [...this.advisorExpansion],
			contextExpansion: [...contextExpansion],
			toolExpansion: [...toolExpansion],
			thinkingExpansion: [...thinkingExpansion],
			turnChangesExpansion: [...this.turnChangesExpansion],
			focus,
		};
	}

	/** Re-renders from the model, then restores reading position after the host mounts the new root. */
	public restoreViewState(state: ChatListViewState, items: readonly IChatListItem[], working = false): void {
		for (const [id, expanded] of state.contextExpansion ?? []) this.contextExpansion.set(id, expanded);
		for (const [id, expanded] of state.advisorExpansion) this.advisorExpansion.set(id, expanded);
		for (const [id, expanded] of state.thinkingExpansion ?? []) this.thinkingExpansion.set(id, expanded);
		for (const [id, disclosure] of state.toolExpansion ?? []) this.toolExpansion.set(id, disclosure);
		for (const id of state.turnChangesExpansion ?? []) this.turnChangesExpansion.add(id);
		this.render(items, working);
		this.lastFocusedItemId = state.lastFocusedItemId && this.itemById(state.lastFocusedItemId) ? state.lastFocusedItemId : undefined;
		for (const [id, expanded] of state.contextExpansion ?? []) {
			const context = this.renderedItems.get(id)?.context;
			if (context) context.disclosure.open = expanded;
		}
		for (const [id, disclosure] of state.toolExpansion ?? []) {
			this.renderedItems.get(id)?.toolPart?.restoreDisclosure(disclosure);
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
		this.pausedReplyScrollTop = undefined;
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
		this.pausedReplyScrollTop = undefined;
		if (this.virtualRows) this.moveVirtualViewport(this.scrollable.state.maximumTop);
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
		// Transcript padding can create a scroll range even in an empty draft.
		const hidden = !this.visible || this.items.length === 0 && !this.working || maximumTop - top <= 1;
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
		// A delayed scroll event at the cancel position should leave following paused.
		if (top !== this.pausedReplyScrollTop) this.pausedReplyScrollTop = undefined;
		// The native scroll position and rounded scroll range can differ by one pixel at the bottom.
		this.shouldFollow = this.pausedReplyScrollTop === undefined && this.canFollowReplies() && maximumTop - top <= 1;
		this.readingPosition = this.shouldFollow ? undefined : this.readingAnchor();
	}

	private captureFollowState(): boolean {
		// DOM scrolling can precede its scroll event. Capture it before layout consumes that
		// position, otherwise an async size measurement can mistake reading for following.
		const state = this.scrollable.state;
		const viewport = this.scrollable.scrollableElement;
		const top = viewport.scrollTop;
		// If the native position agrees with our state, the layout that commits the
		// change (or the resize observer) owns the next scrollbar measurement.
		if (top === state.top) return false;
		// A shrinking composer or transcript can clamp the native viewport before
		// the scrollbar has measured the new range. That clamp is still at bottom.
		const maximumTop = Math.min(state.maximumTop, viewport.scrollHeight - viewport.clientHeight);
		this.updateReplyFollowing(top, maximumTop);
		this.layingOut = true;
		try { this.scrollable.layout(); }
		finally { this.layingOut = false; }
		this.updateScrollToLatestVisibility();
		return true;
	}

	private layout(anchor?: ReadingAnchor, captureScroll = true, stickToBottom = false): void {
		if ((captureScroll && this.captureFollowState()) || !anchor) anchor = this.readingPosition;
		this.layingOut = true;
		try {
			this.measureVirtualRows();
			this.scrollable.layout();
			if (this.shouldFollow || stickToBottom) {
				this.scrollable.scrollTo(0, this.scrollable.state.maximumTop);
			} else if (anchor) {
				const row = this.renderedItems.get(anchor.id);
				if (row) {
					const contentTop = row.element.getBoundingClientRect().top - this.transcript.getBoundingClientRect().top;
					this.scrollable.scrollTo(0, contentTop - anchor.viewportTop);
				} else if (this.virtualRows) {
					const index = this.virtualRows.indexOf(anchor.id);
					if (index !== undefined) this.scrollable.scrollTo(0, this.virtualRows.positionAt(index) + this.virtualPadding - anchor.viewportTop);
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

	private promptTop(id: string): number {
		if (this.virtualRows) {
			const index = this.virtualRows.indexOf(id)!;
			const viewport = this.scrollable.scrollableElement;
			return viewport.getBoundingClientRect().top - viewport.scrollTop + this.virtualPadding + this.virtualRows.positionAt(index);
		}
		return this.renderedItems.get(id)!.element.getBoundingClientRect().top;
	}

	private updateStickyPrompt(): void {
		let item: IChatListItem | undefined;
		let index = 0;
		const { prompts } = this.promptModel;
		const total = prompts.length;
		if (this.visible && !this.transcript.style.paddingTop) {
			const viewport = this.scrollable.scrollableElement.getBoundingClientRect();
			// A reveal can round the scroll position, leaving its prompt just below the top edge.
			index = this.promptModel.firstPromptAfter(viewport.top + 1);
			const active = prompts[index - 1];
			if (this.promptTimeline) {
				const focused = this.getFocus();
				const focusedRow = focused?.type === 'userMessage' ? this.renderedItems.get(focused.id)?.element : undefined;
				const focusedBounds = focusedRow?.contains(this.transcript.ownerDocument.activeElement) ? focusedRow.getBoundingClientRect() : undefined;
				// Focus takes precedence while the prompt is visible. The sticky header still follows scrolling.
				const focusedPrompt = focusedBounds && focusedBounds.bottom > viewport.top && focusedBounds.top < viewport.bottom
					? focused : undefined;
				this.promptTimeline.setActive((focusedPrompt ?? active ?? prompts[0])?.id);
			}
			// Keep the original row at the top when revealing it. Pin only after
			// it crosses the edge by enough to absorb fractional scroll positions.
			if (viewport.height > 0 && active && this.promptModel.top(active) < viewport.top - 2
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
		if (this.virtualRows) {
			const top = this.scrollable.scrollableElement.scrollTop - this.virtualPadding;
			const index = Math.min(this.virtualRows.count - 1, this.virtualRows.indexAt(top));
			const item = this.virtualRows.itemAt(index);
			return item && { id: item.id, viewportTop: this.virtualRows.positionAt(index) - top };
		}
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
