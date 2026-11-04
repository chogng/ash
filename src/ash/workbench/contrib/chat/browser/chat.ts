import type { PromptFileDiff } from './promptTimeline/promptTimelineModel.js';
import type { ChatMode } from '../../../services/chat/common/chatService.js';
import type { IChatInputPart } from './widget/input/chatInputPart.js';
import type { ChatRequestQueueKind } from '../../../services/chat/common/chatService.js';
import type { IView } from '../../../common/views.js';
import type { AgentSessionsViewerOrientation } from './agentSessions/agentSessions.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';
import type { IRange } from '../../../../editor/common/core/range.js';
import type { IChatCopiedInlinePrompt } from './attachments/chatVariables.js';
import type { Selection } from '../../../../editor/common/core/selection.js';
import type { ChatWidget } from './widget/chatWidget.js';
import type { IChatListItem } from '../common/model/chatViewModel.js';
import type { ChatEditorInput } from './widgetHosts/editor/chatEditorInput.js';

export interface IChatAcceptInputOptions {
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
	readonly configureModelInMenu?: boolean;
	readonly promptTimelineFiles?: (prompt: IChatListItem) => readonly PromptFileDiff[];
	readonly workspacePickerDelegate?: IWorkspacePickerDelegate;
	readonly submitHandler?: (query: string, mode: ChatMode, attachedContext: readonly ChatContextAttachment[], signal?: AbortSignal) => Promise<boolean>;
}

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
	/** Edits a queued request without replacing the unsent composer draft. */
	startEditing(requestId: string): void | Promise<void>;
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
