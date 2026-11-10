import type { PromptTurnChanges } from './promptTimeline/promptTimelineModel.js';
import type { ChatMode } from '../../../services/chat/common/chatService.js';
import type { IChatInputPart } from './widget/input/chatInputPart.js';
import type { ChatRequestQueueKind, QueuedMessage } from '../../../services/chat/common/chatService.js';
import type { IView } from '../../../common/views.js';
import type { AgentSessionsViewerOrientation } from './agentSessions/agentSessions.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { h } from '../../../../base/browser/dom.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import type { Event } from '../../../../base/common/event.js';
import type { Icon } from '../../../../base/common/icon.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';
import type { IRange } from '../../../../editor/common/core/range.js';
import type { IChatCopiedInlinePrompt } from './attachments/chatVariables.js';
import type { Selection } from '../../../../editor/common/core/selection.js';
import type { ChatListWidget } from './widget/chatListWidget.js';
import type { ChatWidget } from './widget/chatWidget.js';
import type { IChatListItem } from '../common/model/chatViewModel.js';
import type { ChatEditorInput } from './widgetHosts/editor/chatEditorInput.js';

export const CHAT_WIDGET_VIEW_STATE_CACHE_LIMIT = 100;

/** Binds a toolbar action to its rendered message and row lifetime. */
export class ChatMessageActionContext extends Disposable {
	constructor(
		private currentItem: IChatListItem,
		readonly actions: HTMLElement,
		private readonly isVisible: () => boolean,
	) { super(); }

	get visible(): boolean { return !this.isDisposed && this.isVisible(); }
	get item(): IChatListItem { return this.currentItem; }

	update(item: IChatListItem): void {
		this.currentItem = item;
	}
}

export class ChatRequestActionContext extends ChatMessageActionContext {
	constructor(
		item: IChatListItem, actions: HTMLElement, isVisible: () => boolean,
		readonly startEditing: (requestId: string) => void | Promise<void>,
		readonly getVersions?: (item: IChatListItem) => Promise<readonly ChatRequestVersion[]>,
	) {
		super(item, actions, isVisible);
	}
}

export interface ChatRequestVersion {
	readonly text: string;
	readonly selected: boolean;
	select(): Promise<void>;
}

/** Binds reply actions and playback to the row's lifetime. */
export class ChatResponseActionContext extends ChatMessageActionContext {
	private playback: AbortController | undefined;
	private status: HTMLElement | undefined;

	constructor(
		item: IChatListItem,
		actions: HTMLElement,
		readonly window: Window & typeof globalThis,
		isVisible: () => boolean,
		private readonly setReading: (reading: boolean) => void,
		private readonly getFork?: () => (() => Promise<void>) | undefined,
	) { super(item, actions, isVisible); }

	get isReading(): boolean { return !!this.playback; }
	get fork(): (() => Promise<void>) | undefined { return this.visible ? this.getFork?.() : undefined; }

	override update(item: IChatListItem): void {
		const previous = this.item;
		super.update(item);
		if (previous.text !== item.text || previous.attachmentSource?.sessionId !== item.attachmentSource?.sessionId
			|| previous.attachmentSource?.threadId !== item.attachmentSource?.threadId) this.stop();
	}

	async read(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (!this.visible || this.playback || this.item.transient || !this.item.text) return;
		const controller = this.playback = new AbortController();
		if (!this.status) {
			this.status = h(this.actions.ownerDocument, 'span', { className: 'ash-chat-message-read-status', attributes: { role: 'status' } });
			this.actions.append(this.status);
		}
		this.status.textContent = '';
		this.setReading(true);
		try {
			await run(controller.signal);
		} catch (error) {
			if (this.playback === controller && !isCancellationError(error)) {
				this.status.textContent = localize('chat.message.readAloudFailed', 'Could not read response aloud: {0}', String(error));
			}
		} finally {
			if (this.playback === controller) this.stop();
		}
	}

	stop(): boolean {
		const controller = this.playback;
		if (!controller) return false;
		this.playback = undefined;
		controller.abort();
		if (!this.isDisposed) this.setReading(false);
		return true;
	}

	protected override disposeCore(): void {
		this.stop();
		this.status?.remove();
		this.status = undefined;
		super.disposeCore();
	}
}

export function unwrapChatResponseActionContext(context: unknown): unknown {
	return context instanceof ChatResponseActionContext ? context.item : context;
}

/** Retained transcript presentation independent of the host's visibility and DOM focus. */
export type IChatWidgetViewState = Omit<ReturnType<ChatListWidget['getViewState']>, 'visible' | 'focus'>;

export interface IChatAcceptInputOptions {
	readonly background?: boolean;
	readonly queue?: ChatRequestQueueKind;
	readonly cancelCurrentRequest?: boolean;
	readonly sideChat?: boolean;
}

/** A rendered code block borrows its editor and current model from its content owner. */
export interface IChatCodeBlockInfo {
	readonly ownerMarkdownPartId: string;
	readonly codeBlockIndex: number;
	readonly elementId: string;
	readonly uri: URI | undefined;
	readonly languageId: string | undefined;
	focus(): void;
}

/** The Welcome host owns the available targets and the current selection. */
export interface IWorkspacePickerItem {
	readonly uri: URI;
	readonly label: string;
	readonly isFolder: boolean;
}

export interface IWorkspacePickerDelegate {
	getWorkspaces(): IWorkspacePickerItem[];
	getSelectedWorkspace(): IWorkspacePickerItem | undefined;
	setSelectedWorkspace(workspace: IWorkspacePickerItem | undefined): void;
	readonly onDidChangeSelectedWorkspace: Event<IWorkspacePickerItem | undefined>;
	readonly onDidChangeWorkspaces: Event<void>;
	readonly openFolderCommand: string;
}

/** Host routing receives the accepted snapshot before model send; the live editor may already hold another draft. */
export interface IChatWidgetViewOptions {
	readonly showWelcome?: boolean;
	/** Use the default title for undefined, or hide the welcome for null. */
	readonly welcomeTitle?: import('../../../../base/common/observable.js').IObservable<string | null | undefined>;
	readonly configureModelInMenu?: boolean;
	readonly showPromptTimeline?: boolean;
	/** Minimum number of loaded rows for virtualization. Undefined keeps the full transcript mounted. */
	readonly virtualizeHistoryFrom?: import('../../../../base/common/observable.js').IObservable<number | undefined>;
	readonly promptTimelineChanges?: (prompt: IChatListItem) => PromptTurnChanges | undefined;
	readonly openTurnChanges?: ChatTurnChangesOpener;
	readonly messagePresentation?: ChatMessagePresentation;
	readonly codeBlockPresentation?: 'card';
	readonly workspacePickerDelegate?: IWorkspacePickerDelegate;
	readonly submitHandler?: (query: string, mode: ChatMode, attachedContext: readonly ChatContextAttachment[], signal?: AbortSignal) => Promise<boolean>;
}

export interface ChatMessagePresentation {
	readonly user: { readonly name: string; readonly icon?: Icon; };
	readonly assistant: { readonly name: string; readonly icon?: Icon; };
	readonly getReferences?: (item: IChatListItem) => readonly {
		readonly id: string;
		readonly label: string;
		readonly open: (trigger: HTMLElement) => void;
	}[];
}

export type ChatTurnChangesOpener = (source: NonNullable<IChatListItem['feedbackSource']>, signal: AbortSignal) => Promise<void>;

/** The live presentation owns the input; the registry never owns a conversation model. */
export interface IChatWidget {
	getFileTreeInfosForResponse(response: IChatListItem): readonly IChatFileTreeInfo[];
	getLastFocusedFileTreeForResponse(response: IChatListItem): IChatFileTreeInfo | undefined;
	readonly model?: Pick<import('./widget/chatWidget.js').IChatWidgetModel, 'onDidChange' | 'inputState' | 'thread' | 'composerGeneration' | 'items' | 'olderHistory' | 'loadOlderHistory'>;
	readonly input: IChatInputPart;
	readonly sessionId: string | undefined;
	readonly threadId: string | undefined;
	readonly domNode: HTMLElement;
	readonly visible: boolean;
	readonly onDidChangeVisibility: Event<void>;
	readonly inputEditor: ICodeEditor | undefined;
	readonly isTranscriptProgressActive: boolean;
	readonly onDidHide: Event<void>;
	readonly onDidChangeViewModel: Event<void>;
	acceptInput(query?: string, options?: IChatAcceptInputOptions): Promise<void>;
	/** Opens a sent request by row ID, or edits a queued request. */
	startEditing(request: string | QueuedMessage): void | Promise<void>;
	cancelEditing?(): boolean;
	cancelTranscriptProgress?(): boolean;
	retryFailedTurn(turnId?: string): Promise<void>;
	getFindController(): IChatFindController | undefined;
	focusResponseItem(lastFocused?: boolean): void;
	focusCodeBlock(reverse?: boolean): void;
	focusInput(): void;
	getFocus(): IChatListItem | undefined;
	/** An absent item selects the first or last boundary of the current transcript. */
	getSibling(item: IChatListItem | undefined, type: 'next' | 'previous'): IChatListItem | undefined;
	focus(item: IChatListItem): void;
	reveal(item: IChatListItem): void;
	startVoiceConversation(): Promise<void>;
	/** Prepares references within this composer’s draft lifetime and admission rules. */
	acquireContext(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>, signal?: AbortSignal): Promise<readonly ChatContextAttachment[]>;
}

export interface IChatFileTreeInfo {
	readonly treeDataId: string;
	readonly treeIndex: number;
	focus(): void;
}

export interface IChatFindController {
	readonly visible: boolean;
	show(seedText?: string, focus?: boolean): void;
	hide(): void;
	next(): void;
	previous(): void;
	toggleCaseSensitive(): void;
	toggleWholeWord(): void;
	toggleRegex(): void;
	focus(): void;
}

export interface IChatWidgetService {
	readonly onDidChangeWidgets: Event<void>;
	/** Most recently focused, still registered and visible Chat in this window. */
	readonly lastFocusedWidget: IChatWidget | undefined;
	getAllWidgets(): readonly IChatWidget[];
	register(newWidget: IChatWidget): IDisposable;
}

export const IChatWidgetService = createServiceIdentifier<IChatWidgetService>('chatWidgetService');

export interface IQuickChatOpenOptions {
	readonly query: string;
	readonly isPartialQuery?: boolean;
	readonly selection?: Selection;
}

export interface IQuickChatService {
	readonly onDidClose: Event<void>;
	readonly enabled: boolean;
	readonly focused: boolean;
	readonly sessionResource: URI | undefined;
	toggle(options?: IQuickChatOpenOptions): void;
	open(options?: IQuickChatOpenOptions): void;
	focus(): void;
	close(): void;
	openInChatView(): Promise<void>;
}

export const IQuickChatService = createServiceIdentifier<IQuickChatService>('quickChatService');

/** A borrowed presentation: the Sessions adapter retains its model and draft lifetime. */
export interface IQuickChatSession extends IDisposable {
	readonly widget: ChatWidget;
	readonly onDidDispose: Event<void>;
	setVisible(visible: boolean): void;
	reveal(): void;
}

/** The composer remains the owner of preparation; a target admits references to its input. */
export interface IChatPasteTarget {
	/** Canonical captures in this draft, without positional annotations. */
	readonly attachments: readonly ChatContextAttachment[];
	/** Capture the selection's references relative to the clipboard text before the input changes. */
	getCopiedInlinePrompt(ranges: readonly IRange[], copiedText: string): IChatCopiedInlinePrompt | undefined;
	/** Return the accepted identities and positions for the pending draft snapshot. */
	addAttachments(entries: readonly ChatContextAttachment[], signal?: AbortSignal): readonly ChatContextAttachment[];
	removeAttachments(ids: readonly string[]): void;
	/** Bind a captured snapshot to reference text already inserted by an editor paste. */
	addInlineReference(reference: ChatContextAttachment): void;
}

export interface IChatPasteTargetService {
	registerTarget(inputUri: URI, target: IChatPasteTarget): IDisposable;
	getTarget(inputUri: URI): IChatPasteTarget | undefined;
}

export const IChatPasteTargetService = createServiceIdentifier<IChatPasteTargetService>('chatPasteTargetService');

/** Presentation operations for Workbench actions; the product adapter owns selection and drafts. */
export interface IChatViewPane extends IView {
	reopenLastClosedSessionTab(): void;
	createNewChatEditorInput(source?: ChatEditorInput): ChatEditorInput;
	/** Borrowed root used only to measure the host's content frame. */
	readonly element: HTMLElement;
	/** Borrows an independent retained composer; releasing the mount preserves its model and draft. */
	createEmbeddedChat(parent: HTMLElement, titleId: string, options?: IChatWidgetViewOptions): IQuickChatSession;
	getOptimalWidth(): number;
	getSessionsViewerOrientation(): AgentSessionsViewerOrientation;
	getLastDimensions(orientation: AgentSessionsViewerOrientation): { height: number; width: number; } | undefined;
	toggleSessionsSidebar(options?: { readonly visible: boolean; }): boolean;
	focusInput(): void;
	focusSessions(): boolean;
	moveToEditor(): Promise<void>;
	moveSessionToSideBar(resource: URI): Promise<void>;
	openInNewWindow(): Promise<void>;
}
