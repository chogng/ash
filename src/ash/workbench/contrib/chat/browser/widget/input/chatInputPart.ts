import type { IChatWidgetModel } from '../chatWidget.js';
import type { ILifecycleService } from '../../../../../services/lifecycle/common/lifecycle.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { Event } from '../../../../../../base/common/event.js';
import { MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { ScreenshotContextValuePick } from '../../actions/chatContext.js';
import { workspaceTrustPermissionNames } from '../../../../../../platform/workspace/common/workspaceTrust.js';
import { ChatPasteProvidersFeature, createChatFileAttachments } from './editor/chatPasteProviders.js';
import { ChatDragAndDrop } from '../chatDragAndDrop.js';
import { CancellationError, isCancellationError } from '../../../../../../base/common/errors.js';
import { ChatChangesPill } from './chatChangesPill.js';
import type { SkillReference } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { ChatHistoryNavigator } from '../../../common/widget/chatWidgetHistoryService.js';
import type { MessageHistoryEntry } from '../../../../../../platform/messageHistory/common/messageHistory.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import type { ChatInputEditorSelection } from './chatInputEditorRegistry.js';
import '../media/chat.css';
import { IChatSpeechToTextService, ChatSpeechToTextState } from '../../speechToText/chatSpeechToTextService.js';
import { DictationActionViewItem } from '../../speechToText/dictationActionViewItem.js';
import { DictationInput } from '../../speechToText/dictationInputController.js';
import { notifyDictationSubmitted } from '../../speechToText/dictationSession.js';
import { IDictationOnboardingService } from '../../speechToText/dictationOnboarding.js';
import { addDisposableListener, h, stopEvent } from "../../../../../../base/browser/dom.js";
import { ActionViewItem, ButtonActionViewItem } from "../../../../../../base/browser/ui/actionbar/actionViewItems.js";
import type { IAction } from "../../../../../../base/common/actions.js";
import { Separator } from "../../../../../../base/common/actions.js";
import type { Icon } from "../../../../../../base/common/icon.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from "../../../../../../base/common/lifecycle.js";
import { URI } from '../../../../../../base/common/uri.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Lxicon } from "../../../../../../base/common/lxicons.js";
import { localize } from "../../../../../../nls.js";
import { MenuWorkbenchToolBar, WorkbenchToolBar } from "../../../../../../platform/actions/browser/toolbar.js";
import { IMenuService, MenuId } from '../../../../../../platform/actions/common/actions.js';
import { createUuid } from '../../../../../../base/common/uuid.js';
import { AccessibleViewRegistry } from '../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { IInstantiationService } from "../../../../../../platform/instantiation/common/instantiation.js";
import type { IOpenAgentsWindowOptions } from '../../../../../../platform/native/common/nativeHost.js';
import type { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import type { IContextMenuService } from "../../../../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../../../../platform/contextview/browser/contextView.js";
import type { ModelCatalogEntry } from "../../../../../services/chat/common/chatService.js";
import type { ChatAgent } from '../../../../../services/chat/common/chatService.js';
import { AttachContextAction } from '../../actions/chatContextActions.js';
import { createToolSelectionAttachment } from '../../actions/chatToolPicker.js';
import { status as announceStatus } from '../../../../../../base/browser/ui/aria/aria.js';
import { ChatAttachmentModel } from '../../attachments/chatAttachmentModel.js';
import { ChatDynamicVariableModel } from '../../attachments/chatDynamicVariables.js';
import { ChatWidgetPasteTarget } from '../../attachments/chatWidgetPasteTarget.js';
import { IChatAttachmentResolveService } from '../../attachments/chatAttachmentResolveService.js';
import { CopyPasteController } from '../../../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js';
import type { ModelReasoningEffort } from '../../../../../services/chat/common/modelCatalog.js';
import type { ChatContextAttachment, ChatImageCapture } from "../../../../../services/chat/common/chatContextService.js";
import type { ModelRef } from "../../../../../services/chat/common/chatService.js";
import { DesktopSlashCommands, parseSlashCommandInput, SlashCommandCatalog } from "../../../common/slashCommands.js";
import { SkillSelectorCatalog } from "../../../common/skillSelectors.js";
import type { ChatInputDelegate, ChatInputState } from "./chatInput.js";
import { ChatInputEditors, type IChatInputEditor, type IChatInputEditorProvider } from "./chatInputEditorRegistry.js";
import { ChatInputPickerResponsiveLayout } from './chatInputPickerResponsiveLayout.js';
import { ModelPickerActionItem } from './modelPicker/modelPickerActionItem.js';
import { approvalModeDefinition, approvalModeDefinitions } from '../../../../../../platform/agentHost/common/approvalModes.js';
import { PermissionPickerActionItem } from './permissionPickerActionItem.js';
import { ModePickerActionItem, type ChatInputMode } from './modePickerActionItem.js';
import { ChatContextUsageWidget } from '../../widgetHosts/viewPane/chatContextUsageWidget.js';

type ChatInputToolbarPresentation = "mode" | "model" | "mic" | "voice" | "send" | "interrupt";

interface ChatInputToolbarState {
	readonly voiceAvailable: boolean;
	readonly voiceActive: boolean;
	readonly voiceConnected: boolean;
	readonly mode: ChatInputMode;
	readonly canSubmit: boolean;
	readonly hasInput: boolean;
	readonly canInterrupt: boolean;
	readonly inputKind: "message" | "command";
	readonly models: readonly ModelCatalogEntry[];
	readonly selectedModel?: ModelRef;
	readonly selectedReasoningEffort?: ModelReasoningEffort;
	readonly isAutomaticModel: boolean;
	readonly selectedAgent?: ChatAgent;
	readonly agentName?: string;
	readonly canSelectAgent: boolean;
}

const modeOptions: readonly { readonly id: ChatInputMode; readonly label: string; readonly icon?: Icon; }[] = [
	{ id: "agent", label: "Agent", icon: Lxicon.unlimited },
	{ id: "plan", label: "Plan", icon: Lxicon.plan },
	{ id: "debug", label: "Debug", icon: Lxicon.debug },
	{ id: "multitask", label: "Multitask", icon: Lxicon.multitask },
	{ id: "ask", label: "Ask", icon: Lxicon.chat4 },
];

const approvalModeIcons: Record<ChatInputState['approvalMode'], Icon> = {
	auto: Lxicon.sparkle,
	manual: Lxicon.hand,
	bypassPermissions: Lxicon.unlimited,
};

/** Picker composition is selected by the host; input state and operations keep one owner. */
export interface ChatInputPartOptions {
	readonly modePicker: 'visible' | 'hidden';
	readonly modelPickerPosition: 'leading' | 'trailing';
	readonly renderSecondaryToolbar?: boolean;
	/** Sessions hosts bind their own paste/drop events while sharing preparation and pending state. */
	readonly fileEvents?: 'input' | 'host';
	/** Sessions composers already own persisted drafts; the regular input retains them in memory. */
	readonly draftStorage?: 'input' | 'host';
}

/** The product supplies its existing workspace draft store; the input owns snapshots and async writes. */
export interface IChatDraftStorage {
	read(identity: string): NonNullable<IOpenAgentsWindowOptions['draft']> | undefined;
	write(identity: string, draft: NonNullable<IOpenAgentsWindowOptions['draft']> | undefined): void;
	flush(): Promise<void>;
}

/** Input operations consumed by a Chat pane, independent of its product's composer layout. */
export interface IChatInputPart extends IDisposable {
	readonly inputEditor?: IChatInputEditor['codeEditor'];
	readonly attachmentModel: ChatAttachmentModel;
	readonly element: HTMLElement;
	/** Retires asynchronous input work without clearing or restoring the next conversation’s draft. */
	invalidatePendingInput(): void;
	focus(): void;
	addContext(attachment: ChatContextAttachment): void;
	captureScreenshot(capture?: ChatImageCapture): Promise<void>;
	attachFiles(files: readonly File[], signal?: AbortSignal): Promise<void>;
	acquireContext(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>, signal?: AbortSignal): Promise<readonly ChatContextAttachment[]>;
	captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined>;
	appendToDraft(text: string): void;
	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void;
	acceptInput(value?: string): Promise<void>;
	openModelSelector(): void;
	setVisible(visible: boolean): void;
	render(state: ChatInputState): void;
}

interface InputHistoryDraft {
	readonly text: string;
	readonly selection: ChatInputEditorSelection;
	readonly attachments: readonly ChatContextAttachment[];
	readonly skills: readonly SkillReference[];
}

type HistorySearchItem = IQuickPickItem & ({ readonly kind: 'entry'; readonly entry: MessageHistoryEntry; } | { readonly kind: 'more'; readonly before: string; });

/** Owns the complete input region and all user-facing interactions for one Chat pane. */
export class ChatInputPart extends Disposable implements IChatInputPart {
	private readonly screenshotContext: ScreenshotContextValuePick;
	readonly element: HTMLElement;
	private readonly history: ChatHistoryNavigator<InputHistoryDraft>;
	private readonly historySearch = this._register(new MutableDisposable<DisposableStore>());
	private applyingHistory = false;
	private historyInputRevision = 0;
	private draftSkills: { readonly text: string; readonly references: readonly SkillReference[]; } | undefined;
	private persistentDrafts = false;
	private draftIdentity: ChatInputState['draftIdentity'];
	private readonly conversationDrafts = new Map<string, InputHistoryDraft & { readonly mode: ChatInputMode; }>();
	private readonly inputChanges = this._register(new Emitter<void>());
	protected readonly onDidChangeInput = this.inputChanges.event;
	private readonly delegate: ChatInputDelegate;
	private readonly interactionListeners = this._register(new DisposableStore());
	private renderedInteraction: ChatInputState['interaction'];
	private readonly attachContext = this._register(new MutableDisposable<AttachContextAction>());
	private readonly attachAction: IAction = {
		id: 'ash.chat.input.attach', label: localize('chat.context.add', 'Add context'), tooltip: localize('chat.context.add', 'Add context'), icon: Lxicon.add, enabled: true,
		run: () => {
			// The command creates the picker owner only when this composer opens it.
			this.attachContext.value ??= this.instantiationService.createInstance(AttachContextAction, {
				container: this.inputContainer, target: this, focusInput: () => this.focus(), supportsImages: () => this.supportsImages(), getDisabledTools: async () => {
					const selection = this.contexts.find(attachment => attachment.kind === 'toolSelection');
					return selection ? JSON.parse((await selection.resolve()).content) as string[] : [];
				}
			});
			return this.attachContext.value.run(this.element.querySelector<HTMLElement>('[data-action-id="ash.chat.input.attach"] button') ?? undefined);
		},
	};
	public readonly attachmentModel = this._register(new ChatAttachmentModel());
	private readonly inlineContext: ChatDynamicVariableModel;
	private readonly pasteTarget: ChatWidgetPasteTarget;
	private synchronizingSourceContext = false;
	private readonly status: HTMLDivElement;
	private readonly dictationPreview: HTMLDivElement;
	private readonly interaction: HTMLDivElement;
	protected readonly inputContainer: HTMLFormElement;
	protected readonly input: IChatInputEditor;
	private readonly inputToolbar: WorkbenchToolBar;
	private readonly changesPill: ChatChangesPill;
	private readonly secondaryToolbarContainer: HTMLElement | undefined;
	private readonly footerChanged = this._register(new Emitter<void>());
	private permissionWidget: PermissionPickerActionItem | undefined;
	private footerContextToolbar: WorkbenchToolBar | undefined;
	private footerContextAction: IAction | undefined;
	private contextUsageWidget: ChatContextUsageWidget | undefined;
	// Retaining this action keeps the open picker and its focused switch alive when the selection changes.
	private readonly modelAction = new ChatInputAction('ash.chat.input.model', '', '', undefined, true, 'model', () => { });
	private readonly modelPickerPresentationChanged = this._register(new Emitter<void>());
	// The toolbar owns the retained item; commands open it without synthesizing DOM events.
	private modelPickerActionItem!: ModelPickerActionItem;
	private modePickerActionItem: ModePickerActionItem | undefined;
	private readonly pickerResponsiveLayout: ChatInputPickerResponsiveLayout;
	private readonly slashCommands = new SlashCommandCatalog(DesktopSlashCommands, []);
	private readonly skills = new SkillSelectorCatalog();
	private state: ChatInputState = { mode: "agent", queuedMessages: 0, approvalMode: 'manual', phase: "loading", canInterrupt: false, models: [], isAutomaticModel: false, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	private toolbarState: ChatInputToolbarState = { voiceAvailable: false, voiceActive: false, voiceConnected: false, mode: "agent", canSubmit: false, hasInput: false, canInterrupt: false, inputKind: "message", models: [], isAutomaticModel: false, canSelectAgent: false };
	private serverSlashCommands: ChatInputState["slashCommands"] = [];
	private skillSelectors: ChatInputState["skillSelectors"] = [];
	private get mode(): ChatInputMode { return this.state.mode; }
	private readonly dictationSession: DictationInput;
	private readonly dictationHost = this._register(new MutableDisposable());
	private dictationSample: { text: string; backend: string; } | undefined;
	private measuringDictation = false;
	private measureWholeDraft = false;
	private visible = true;
	private draftRevision = 0;
	private textRevision = 0;
	private acceptingContext = false;
	private submitting = false;
	// Retained panes can change conversation without disposing their editor.
	private inputLifecycle = new AbortController();

	constructor(
		container: HTMLElement,
		delegate: ChatInputDelegate,
		contextMenuService: IContextMenuService,
		contextViewService: IContextViewService,
		private readonly accessibleViewService: IAccessibleViewService,
		private readonly notifications: INotificationService,
		editorProvider: Pick<IChatInputEditorProvider, 'create'> = ChatInputEditors,
		private readonly additionalActions: readonly IAction[] = [],
		private readonly options: ChatInputPartOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatSpeechToTextService private readonly speechToText: IChatSpeechToTextService,
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IMenuService menuService: IMenuService,
		@IChatAttachmentResolveService private readonly attachmentResolver: IChatAttachmentResolveService,
	) {
		super();
		this.screenshotContext = instantiationService.createInstance(ScreenshotContextValuePick);
		const ownerDocument = container.ownerDocument;
		this.delegate = delegate;
		this.history = this._register(instantiationService.createInstance(ChatHistoryNavigator<InputHistoryDraft>));
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-chat-input-part";
		container.append(this.element);
		this.status = h(ownerDocument, "div");
		this.status.className = "ash-chat-status";
		this.status.setAttribute("role", "status");
		this.dictationPreview = h(ownerDocument, "div");
		this.dictationPreview.className = "ash-chat-dictation-preview";
		this.dictationPreview.setAttribute("aria-hidden", "true");
		this.dictationPreview.hidden = true;
		this.interaction = h(ownerDocument, "div");
		this.interaction.className = "ash-chat-interaction";
		this.interaction.setAttribute("aria-live", "polite");
		this.inputContainer = h(ownerDocument, "form");
		this.inputContainer.className = "ash-chat-input-container";
		const editorHost = h(ownerDocument, "div");
		editorHost.className = "ash-chat-input-editor-host";
		this.input = this._register(editorProvider.create({
			container: editorHost,
			placeholder: "Ask Ash",
			ariaLabel: "Chat message",
			slashCommands: this.slashCommands,
			skills: this.skills,
		}));
		this.inlineContext = this._register(new ChatDynamicVariableModel(this.input, this.attachmentModel));
		this.pasteTarget = this._register(instantiationService.createInstance(ChatWidgetPasteTarget, this.input, this.inlineContext, this.attachmentModel));
		if (this.input.codeEditor && this.input.getModel) {
			this._register(instantiationService.createInstance(ChatPasteProvidersFeature, this.input, () => this.inputLifecycle.signal, () => this.supportsImages()));
		}
		this.inputToolbar = this._register(new WorkbenchToolBar(this.inputContainer, contextMenuService, {
			ariaLabel: localize('chat.input.actions', 'Chat input actions'),
			actionViewItemProvider: action => this.createToolbarViewItem(action, contextViewService),
		}));
		this.inputToolbar.element.classList.add("ash-chat-input-toolbars");
		this.inputToolbar.element.classList.toggle('model-picker-trailing', options.modelPickerPosition === 'trailing');
		this.pickerResponsiveLayout = this._register(new ChatInputPickerResponsiveLayout(this.inputToolbar.element));
		this.inputContainer.append(editorHost, this.inputToolbar.element);
		this.secondaryToolbarContainer = options.renderSecondaryToolbar === false
			? undefined
			: this.createSecondaryToolbar(contextMenuService, menuService);
		this.changesPill = this._register(instantiationService.createInstance(ChatChangesPill, this.element, () => {
			void this.runSecondaryAction(async () => { await this.delegate.openChanges?.(this.state.changesRevision); });
		}, () => this.focus(), this.delegate.readWorkspaceChanges));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 95, name: `chatAttachments-${type}-${createUuid()}`,
				getProvider: () => {
					const focused = this.element.ownerDocument.activeElement as HTMLElement | null;
					const footerFocused = focused && this.secondaryToolbarContainer?.contains(focused);
					const changesFocused = focused && this.changesPill.domNode.contains(focused);
					const referencePreview = focused?.closest<HTMLElement>('.ash-chat-context-reference-preview');
					const previewAttachment = referencePreview && this.inlineContext.variables.find(reference => reference.id === referencePreview.dataset.attachmentId);
					const previewOwned = !!previewAttachment;
					if (!focused || (!previewOwned && !footerFocused && !changesFocused && !this.input.element.contains(focused) && !this.inputToolbar.element.querySelector('[data-action-id="ash.chat.input.attach"]')?.contains(focused))) { return undefined; }
					if ((footerFocused || changesFocused) && type === AccessibleViewType.View) { return undefined; }
					if (type === AccessibleViewType.View && this.contexts.length === 0) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type }, () => {
						if (previewOwned) {
							if (previewAttachment?.terminalSnapshot) return localize('terminal.chat.previewAccessibility', 'Saved terminal output: {0}\nThis preview is read only and retains the output captured when attached. Press Escape or Close terminal preview to return to the message.\n\n{1}', previewAttachment.name, previewAttachment.terminalSnapshot.text);
							const image = referencePreview!.querySelector('img')!;
							return localize('chat.context.imagePreviewAccessibility', 'Image preview: {0}\nDimensions: {1} × {2}\nPress Escape or activate Close image preview to return. This view identifies the image; it does not describe its contents.', image.alt, image.naturalWidth, image.naturalHeight);
						}
						const names = this.contexts.map(attachment => attachment.name).join('\n');
						return type === AccessibleViewType.View ? names : localize('chat.context.help', 'Chat context\nUse Add context to search recent and workspace files, attach files or images, read an image from the clipboard, take a screenshot, select a session, issue or pull request, choose Files & Folders to include a directory, add open editors including unsaved text, or select another context source. Add context opens a searchable menu beside its button and focuses the search field. Press Enter or Space on Add context to open it; activate it again to close it. Type to search, use arrow keys to choose, Enter to attach, Ctrl or Command+Enter to attach and keep searching, and Escape to return from a source picker to attachment search. Escape in attachment search cancels and returns focus to the message. After attaching, focus returns to the message. Use Go back to return to the previous picker. Directory attachments include their path and file list. Session and GitHub attachments capture their content when selected. Terminal attaches selected text or recent output. Symbols attach their source range, including unsaved edits. Search Results attaches the completed search and its match locations. These attachments keep the content captured when selected; their source button returns to the terminal, code or Search view. Tools attaches an enabled tool or tool set. Choose Configure tools, use Enter to toggle a tool or set, then choose Apply to save for this chat. Escape discards changes. Selection applies to the next request and is retained after sending; remove its attachment to reset. Steering cannot change a running request’s selection. A tool reference’s source button opens Tools settings. Calls use the current tool catalog and execution permissions. Instructions selects from the authorized user and directory catalog; the backend loads the current instruction when sending. Its source button opens the instruction file. Browser screenshots ask you to choose a screen, window or tab and can be cancelled. GitHub pickers let you choose an account and repository, paste a link, enter a number or load more items. Context references are inserted at the message cursor. Use Tab to reach their source and Remove buttons; Enter opens its source. Removing a reference returns focus to the message. Paste or drop files into the message to attach them. Sending waits until file preparation finishes; a failed preparation keeps the draft. Attachments can be sent without text and remain in the draft when sending fails.') + '\n' + localize('chat.screenshot.shortcutHelp', 'Use {0} or Screenshot: Capture Screen in the Command Palette to capture an image, then copy, save, or add it to chat. Customize the shortcut in Screenshot settings or Keyboard Shortcuts.', '<keybinding:workbench.action.chat.attachScreenshot>') + '\n' + this.screenshotContext.accessibilityHelp + '\n' + localize('chat.tool.help', 'Tool calls appear as collapsed summaries. Use Tab to reach a summary and Enter or Space to expand its input, source, execution target, standard output, standard error and result. Streaming updates retain focus and expansion. Failed calls show an error; a finished turn without a result is never shown as successful.') + '\n' + localize('hooks.feedbackHelp', 'Hook summaries show running, allowed to continue, blocked, failed, or cancelled results. Allowed means the Hook permits the action to continue; it does not confirm that the tool or Turn succeeded. Blocked and failed Hooks are errors; cancellation is reported separately. Use Tab to reach a Hook summary and Enter or Space to expand a reason when one is available. Status updates preserve the summary focus and expanded details. Execution Trace shows the recorded status and duration; enable detailed recording to load commands and input/output on demand.') + '\n' + localize('chat.ai.disabled.help', 'Disable AI features in Settings hides Chat in the Code window and prevents new Chat requests. History and drafts are kept. Active voice conversations stop; running work can still be stopped. Turn the setting off to restore Chat.') + '\n' + localize('chatSession.actionsHelp', 'Choose Archive or Mark as Done in Chat More Actions or the Command Palette. After confirmation, running work in the session is interrupted. Choose Restore or Unarchive to list archived sessions; press Enter to restore and open the root conversation. Restore All restores the listed sessions without changing the current conversation. Restoring never restarts work. Unsent drafts are kept.') + '\n' + localize('chat.history.recoveryHelp', 'When chat history or updates cannot load, use Tab to reach Retry loading chat and Enter or Space to retry. Recovery preserves your draft and attachments and never sends a message. Sending stays unavailable until loading succeeds. Closing accessibility help returns focus to recovery, or to the message input when recovery is complete.') + '\n' + localize('chat.voice.help', 'Voice conversation: when available, focus Voice conversation and press Enter or Space to start. Choose a provider, model and voice from the searchable options, then press Enter. Press Escape to cancel without starting media. Stop voice conversation closes the microphone and reply playback. Interrupt voice reply retires the current reply and reconnects speech. Switching conversations stops voice. Spoken task requests use the current Chat mode, queue and approvals; unsent text and attachments remain in the draft. Your speech and voice replies appear as plain-text transcripts in the conversation.') + '\n' + localize('chat.editor.help', 'Use Move Chat to Editor Area in Chat More Actions or the Command Palette to move this conversation into an editor tab. Its unsent text, attachments and history stay with the same composer. Move Chat to Side Bar or close the Chat editor to return it. You can keep a document beside Chat. Switching tabs never sends a message; drafts and the selected conversation restore after restarting the window.') + '\n' + localize('chat.history.help', 'Chat input: Enter sends; Shift+Enter inserts a line. At the first or last input row, Arrow Up and Arrow Down recall earlier inputs. Press Ctrl+R to search all input history; Enter restores the selected text without sending it. Escape restores the original draft, cursor, attachments and Skill bindings. Input history belongs to the local Profile and stores text only. In the Code window, use the conversation title or Show Chat History to switch conversations and unfinished drafts. Switching keeps their inputs. Press Escape to dismiss the picker and return to the title.') + '\n' + (this.secondaryToolbarContainer ? localize('chat.input.secondaryHelp', 'Below the input, Add context is to the left of the approval mode button. Added attachments appear inside the input. The approval mode button shows the current mode. Press Enter or Space to open its menu above the button, use arrow keys to choose a mode, and Escape to close the menu and return focus. Full access requires confirmation. The context ring shows estimated input as a share of the automatic compaction budget. Model context capacity is shown separately. Hover or focus it to read the percentage and token counts, or activate it to open the breakdown above the ring. Unknown capacity uses an empty ring and shows token counts without a percentage. Press Escape or activate Close to close the details and return to the ring. Loading, working and error status appears alongside extension status indicators. Use Tab to reach each toolbar, arrow keys to move between actions, and Enter or Space to activate an action.') : '') + '\n' + localize('chat.input.changesHelp', 'The changes button above the input shows workspace changes in New Chat, or net changes at the current checkpoint inside a conversation. Undo and redo update the summary. Use Tab to reach it and Enter or Space to open Changes. A conversation with no changes never shows workspace changes. An unavailable summary offers a retry instead of showing zero changes.') + '\n' + localize('chat.context.inlineSelectionHelp', 'Choose a file in Add context, including workspace files, Open editors or Attach files, or paste or drop a code file to insert its name at the message cursor. Images from Add context, paste or drop also insert their file name at the message cursor, with a thumbnail and Remove button. Activate the thumbnail or file name to preview the image; Escape or Close image preview returns to the image reference. Use Tab to reach the image Preview and Remove buttons. Select code in an editor and choose Add Selection to Chat, or press Ctrl or Command+L, to insert the file name and line range. All context references appear in the message. References are single units: the caret stays before or after them, and extending a selection includes the whole reference. Arrow Left and Arrow Right move across a reference; Backspace or Delete removes it and its captured context. Undo in the rich input restores the reference and its captured code. Drafts retain references and unsaved code snapshots.') + '\n' + localize('chat.context.referenceSourceHelp', 'Hover over a reference to preview its captured content. At a reference, use {0} to open the same information; Escape returns to the message. Click a file or code reference, or press Alt+Enter at it, to open the full saved content in a read-only editor. Opening saved content keeps the draft and never sends a message.', '<keybinding:editor.action.showHover>') + '\n' + localize('chat.context.copyHelp', 'Copy or cut a message selection to keep its references and captured content when pasting into Chat. Undo and redo restore the pasted text and references together. Paste as plain text inserts labels without their captured content. After copying code in an editor, Paste options offers Pasted Code Attachment. Choosing it keeps the copied selection even if the source changes or closes.') + '\n' + localize('chat.context.attachmentWidgetHelp', 'File, image and terminal references have native Open or Preview and Remove buttons. Use Tab to reach them and Enter or Space to activate them. While an image is loading, Tab skips its unavailable preview and still reaches Remove. If captured image bytes cannot be decoded, the reference reports Preview unavailable and stays removable; its captured content is preserved through undo, draft restoration and copy-paste. Delete or Backspace on either button removes that reference; Undo restores its captured content. At a reference, Alt+Enter opens its saved file content, prepared image or terminal snapshot. Image and terminal previews open a dialog; Escape or Close returns focus to the reference. A terminal preview can also return to its original terminal. Removing a reference or closing the input closes its preview.') + '\n' + localize('chat.context.otherWidgetHelp', 'Other context references also have native Open and Remove buttons. Tab reaches each button, Enter or Space activates it, and Delete or Backspace removes only that reference even when the text caret is elsewhere. Undo restores its captured context. Directories return to Explorer, instructions open their authorized file, tools and tool selections open Tools settings, and search results return to Search. Other source links retain their captured destination. Captured contexts without a navigable source, including debug and source control snapshots, open their saved content in a read-only editor. Opening or removing context never sends the draft.') + '\n' + localize('chat.context.browserScmWidgetHelp', 'Browser element and source control references open captured content in a read-only editor. Their extra source button opens the original web page, commit changes or revision file. If the source is unavailable, saved content remains readable. Use Tab to reach each action. Delete or Backspace removes the focused reference; Undo restores its source identity and captured content.') + '\n' + localize('chat.context.capturePreviewHelp', 'While a context source is loading a new query, its previous results cannot be attached. Escape cancels the selection. Hover over a saved file, browser element, source control or other captured-content reference to preview its saved text. The keyboard hover command shows the same shortened preview; Escape returns to the message. Internal source identities are omitted from these previews. Open editors attaches the displayed version of a read-only editor, including when an editable working copy exists for the same file.') + '\n' + localize('chat.context.resourceActionsHelp', 'Drag a file, folder, source image, instruction file or symbol reference by its source button to use its original resource elsewhere. Right-click the reference, or press Shift+F10 or the Context Menu key on its buttons, for source actions such as Open to the Side, Reveal in Explorer View, Copy Path and Copy Relative Path. Escape returns focus to the invoking button. These actions use the original source and range; the captured attachment and its undo history stay in the message. Images from the clipboard and internal snapshots do not expose source-file actions.') + '\n' + localize('chat.context.receiveDropHelp', 'Drag a file, folder, source image or code reference into the message to attach captured content at the text cursor. Code references capture their source range, including unsaved edits. A mixed drop is added when every item is ready. Undo removes that drop in one step and Redo restores the same captured content. Sending waits for preparation. If any item cannot be read or the model does not support its images, the draft stays unchanged. Leaving the conversation or hiding the input cancels unfinished drops.') + '\n' + localize('chat.context.referenceWidgetHelp', "At a session reference, press Alt+Enter to open the referenced conversation. Use Tab to reach its Open and Remove buttons. Delete or Backspace on either button removes the reference; Undo restores it and its captured content. Opening the conversation never sends the draft.") + '\n' + names;
					}, () => focused.isConnected ? focused.focus() : this.focus(), AccessibilityVerbositySettingId.Chat);
				},
			}));
		}

		this.dictationSession = this._register(instantiationService.createInstance(DictationInput, this.input, this.dictationPreview, () => this.visible, () => this.delegate.openModelSettings('dictation'), 'chat'));
		this._register(Event.any(this.speechToText.onDidChangeState, Event.map(this.dictationSession.onDidChange, () => this.speechToText.state))(() => {
			if (this.dictationSession.isActive && this.speechToText.state === ChatSpeechToTextState.Recording && !this.measuringDictation) {
				this.measuringDictation = true;
				this.measureWholeDraft = !this.input.codeEditor && this.input.value.length === 0;
				this.dictationSample = undefined;
			}
			if (!this.speechToText.isBusy) this.measuringDictation = false;
			this.renderStatus(); this.renderToolbarActions();
		}));
		this._register(this.speechToText.onDidUpdateTranscript(event => {
			if (this.dictationSession.isActive && this.measureWholeDraft && event.finalizedText) this.dictationSample = { text: event.finalizedText, backend: this.speechToText.currentBackend };
		}));
		this._register(this.speechToText.onDidChangePreparingModel(() => this.renderToolbarActions()));
		this._register(this.dictationSession.onDidEnd(error => {
			// The speech service can become idle before the input session releases its active state.
			this.renderStatus();
			this.renderToolbarActions();
			if (error) { this.notifications.error(localize('chat.input.dictationFailed', 'Dictation failed: {0}', error)); }
		}));
		if (!this.secondaryToolbarContainer) this.element.append(this.status);
		this.element.append(this.dictationPreview, this.interaction, this.changesPill.domNode, this.inputContainer);
		if (this.secondaryToolbarContainer) this.element.append(this.secondaryToolbarContainer);
		this.updateDictationHost();
		this._register(addDisposableListener(this.inputContainer, "focusin", event => {
			this.inputContainer.classList.add("focused");
			if (this.input.element.contains(event.target as Node)) {
				const hint = this.accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
				if (hint) { announceStatus(hint); }
			}
		}));
		this._register(addDisposableListener(this.inputContainer, "focusout", event => {
			if (this.inputContainer.contains(event.relatedTarget as Node | null)) return;
			this.inputContainer.classList.remove("focused");
		}));
		this._register(addDisposableListener(this.inputContainer, "submit", (event) => {
			event.preventDefault();
			void this.acceptInput().catch(() => undefined);
		}));
		this._register(this.input.onDidChange(() => {
			if (!this.applyingHistory) this.draftSkills = undefined;
			this.textRevision++;
			this.draftRevision++;
			if (!this.applyingHistory) { this.history.reset(); this.historyInputRevision++; }
			this.inputChanges.fire();
			this.renderStatus();
			this.renderToolbar();
		}));
		this._register(addDisposableListener(this.input.element, "keydown", event => this.handleHistoryKey(event), true));
		this._register(this.input.onDidSubmit(() => this.inputContainer.requestSubmit()));
		this._register(this.inlineContext.onDidChangeReferences(() => {
			this.draftRevision++;
			this.renderToolbar();
			this.inputChanges.fire();
		}));
		this._register(this.inlineContext.onDidRemoveReference(context => {
			if (context.lifetime === 'source' && !this.synchronizingSourceContext) this.attachmentModel.delete(context.id);
		}));
		this._register(this.attachmentModel.onDidChange(() => {
			this.draftRevision++;
			this.renderToolbar();
			this.inputChanges.fire();
		}));
		this._register(this.attachmentModel.onDidChangePendingContext(() => {
			this.draftRevision++;
			if (!this.applyingHistory) { this.history.reset(); this.historyInputRevision++; }
			this.renderToolbar();
			this.inputChanges.fire();
		}));
		if (options.fileEvents !== 'host') {
			this._register(addDisposableListener(this.inputContainer, 'paste', event => {
				const files = [...(event.clipboardData?.files ?? [])];
				if (files.length === 0) return;
				stopEvent(event);
				void this.attachFiles(files);
			}, true));
			this._register(instantiationService.createInstance(ChatDragAndDrop, this, () => this.supportsImages())).addOverlay(this.inputContainer, this.inputContainer);
		}
		this.renderToolbarActions();
		this._register(toDisposable(() => this.element.remove()));
		this._register(toDisposable(() => this.inputLifecycle.abort()));
		this._register(toDisposable(() => this.conversationDrafts.clear()));
		this._register(toDisposable(() => { this.logDictationSample(false); void this.stopDictation(); }));
	}

	private captureHistoryDraft(): InputHistoryDraft {
		return { text: this.input.value, selection: this.input.getSelection(), attachments: this.contexts, skills: this.draftSkills?.text === this.input.value ? this.draftSkills.references : this.skills.referencesIn(this.input.value) };
	}

	private applyHistoryDraft(draft: InputHistoryDraft): void {
		this.applyingHistory = true;
		try {
			this.setInputValue(draft.text);
			this.input.setSelection(draft.selection);
			this.setReferenceState(draft.attachments);
			this.draftSkills = { text: draft.text, references: draft.skills };
		} finally {
			this.applyingHistory = false;
		}
	}

	private applyHistoryEntry(entry: MessageHistoryEntry): void {
		this.applyingHistory = true;
		try {
			this.setInputValue(entry.text);
			this.input.setSelection({ anchor: entry.text.length, active: entry.text.length });
			this.attachmentModel.cancelPendingContext();
			this.setReferenceState([]);
			this.draftSkills = undefined;
		} finally {
			this.applyingHistory = false;
		}
		announceStatus(localize('chat.history.recalled', 'Recalled input. Press Escape to restore your draft.'));
	}

	private handleHistoryKey(event: KeyboardEvent): void {
		if (event.isComposing || event.defaultPrevented) return;
		if (event.ctrlKey && !event.shiftKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'r') {
			stopEvent(event);
			if (!this.history.available) {
				this.notifications.info(localize('chat.history.unavailable', 'Input history is unavailable on this connection.'));
				return;
			}
			this.showHistorySearch();
			return;
		}
		if (event.key === 'Escape' && this.input.element.querySelector('.stanza-editor-completion:not([hidden])')) return;
		if (event.key === 'Escape' && this.history.active) {
			stopEvent(event);
			const draft = this.history.restore();
			if (draft) this.applyHistoryDraft(draft);
			return;
		}
		if (!this.history.available || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
		const direction = event.key === 'ArrowUp' ? 'previous' : event.key === 'ArrowDown' ? 'next' : undefined;
		if (!direction || this.input.element.querySelector('.stanza-editor-completion:not([hidden])')) return;
		if (!this.history.active && !this.input.isAtHistoryBoundary(direction)) return;
		stopEvent(event);
		const revision = this.historyInputRevision;
		const operation = direction === 'previous' ? this.history.previous(this.captureHistoryDraft()) : this.history.next();
		void operation.then(result => {
			if (!result || this.isDisposed || revision !== this.historyInputRevision) return;
			if (result.kind === 'history') this.applyHistoryEntry(result.entry);
			else this.applyHistoryDraft(result.draft);
		}).catch(error => {
			if (!this.isDisposed && revision === this.historyInputRevision) this.notifications.error(localize('chat.history.readFailed', 'Could not read input history: {0}', String(error)));
		});
	}

	private showHistorySearch(): void {
		this.historySearch.clear();
		this.history.invalidatePending();
		const draft = this.captureHistoryDraft();
		const revision = this.historyInputRevision;
		const resources = new DisposableStore();
		const picker = resources.add(this.quickInput.createQuickPick<HistorySearchItem>());
		this.historySearch.value = resources;
		picker.placeholder = localize('chat.history.searchPlaceholder', 'Search input history. Enter restores the selected text; Escape keeps your draft.');
		picker.ariaLabel = localize('chat.history.searchLabel', 'Search input history');
		picker.sortByLabel = false;
		picker.filterValue = () => '';
		let accepted = false;
		let closed = false;
		let generation = 0;
		let entries: HistorySearchItem[] = [];
		resources.add(toDisposable(() => { closed = true; generation++; }));
		const load = async (text: string, before?: string): Promise<void> => {
			const token = ++generation;
			picker.busy = true;
			if (!before) { picker.items = []; entries = []; }
			try {
				const page = await this.history.search(text, before);
				if (closed || this.isDisposed || token !== generation) return;
				const rows: HistorySearchItem[] = page.entries.map(entry => ({
					kind: 'entry', entry, label: entry.text.split(/\r?\n/u)[0] || entry.text,
					detail: entry.text, description: new Date(entry.submittedAtMs).toLocaleString(),
				}));
				entries = before ? [...entries, ...rows] : rows;
				picker.items = page.nextBefore ? [...entries, { kind: 'more', before: page.nextBefore, label: localize('chat.history.loadMore', 'Load more inputs') }] : entries;
			} catch (error) {
				if (!closed && !this.isDisposed && token === generation) this.notifications.error(localize('chat.history.readFailed', 'Could not read input history: {0}', String(error)));
			} finally {
				if (!closed && token === generation) picker.busy = false;
			}
		};
		resources.add(picker.onDidChangeValue(text => { void load(text); }));
		resources.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;

			if (item.kind === 'more') { void load(picker.value, item.before); return; }
			if (!this.isDisposed && revision === this.historyInputRevision) {
				accepted = true;
				this.history.select(item.entry, draft);
				this.applyHistoryEntry(item.entry);
			}
			picker.hide();

		}));
		resources.add(picker.onDidHide(() => {
			if (closed) return;
			closed = true;
			generation++;
			if (!this.isDisposed) {
				if (!accepted && revision === this.historyInputRevision) this.applyHistoryDraft(draft);
				this.focus();
			}
			this.historySearch.clear();
		}));
		picker.show();
		void load('');
	}

	private async submit(draft: InputHistoryDraft, textRevision: number, lifecycle: AbortSignal, operation: () => Promise<void>): Promise<void> {
		if (this.input.codeEditor) notifyDictationSubmitted(this.input.codeEditor);
		this.logDictationSample(true, draft.text);
		void this.history.record(draft.text, parseSlashCommandInput(this.commandText(draft.text, draft.attachments), this.slashCommands).kind === 'command' ? 'command' : 'agent').catch(error => {
			if (!this.isDisposed && !lifecycle.aborted) this.notifications.error(localize('chat.history.saveFailed', 'Could not save input history: {0}', String(error)));
		});
		// Preparation can finish after the user has started another input; never erase that text.
		const cleared = this.textRevision === textRevision;
		if (cleared) {
			this.setInputValue("");
			if (this.isDisposed || lifecycle.aborted || !this.visible) return;
			this.setReferenceState([]);
			this.pasteTarget.addAttachments(draft.attachments.filter(context => context.kind === 'toolSelection'));
		}
		const revision = this.draftRevision;
		this.renderToolbar();
		try {
			// Clearing the editor notifies owners synchronously and can retire this submission.
			if (this.isDisposed || lifecycle.aborted || !this.visible) return;
			await operation();
			if (this.isDisposed || lifecycle.aborted) return;

		} catch (error) {
			if (!this.isDisposed && !lifecycle.aborted && cleared && this.draftRevision === revision) {
				this.applyHistoryDraft(draft);
				this.renderToolbar();
			}
			throw error;
		}
	}

	focus(): void {
		this.input.focus();
	}

	get inputEditor(): IChatInputEditor['codeEditor'] { return this.input.codeEditor; }

	addContext(attachment: ChatContextAttachment): void {
		if (attachment.lifetime === 'source') this.attachmentModel.addContext(attachment);
		else {
			this.pasteTarget.addAttachments([attachment]);
			this.focus();
		}
		announceStatus(localize('chat.context.insertedReference', 'Inserted {0} at the message cursor', attachment.name));
	}


	protected get contexts(): readonly ChatContextAttachment[] {
		return this.pasteTarget.inlineReferences;
	}

	private setInputValue(value: string): void {
		if (value !== this.input.value) this.logDictationSample(false);
		// Clearing or restoring a draft is not a user revocation of live App context.
		const synchronizing = this.synchronizingSourceContext;
		this.synchronizingSourceContext = true;
		try { this.input.value = value; }
		finally { this.synchronizingSourceContext = synchronizing; }
	}

	private logDictationSample(submitted: boolean, text = this.input.value): void {
		const sample = this.dictationSample;
		this.dictationSample = undefined;
		if (sample) this.speechToText.logDictationAccuracy({ dictatedText: sample.text, submittedText: text, backend: sample.backend, surface: 'chat', submitted });
	}

	private setReferenceState(contexts: readonly ChatContextAttachment[]): void {
		this.inlineContext.setInputState(contexts);
	}

	/** Context selectors borrow this composer’s pending owner; they retain their own error presentation. */
	acquireContext(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>, signal?: AbortSignal): Promise<readonly ChatContextAttachment[]> {
		if (!this.visible) return Promise.reject(new CancellationError());
		return this.attachmentModel.acquireContext(prepare, signal, (attachments, acquisitionSignal) => {
			// Capabilities can change while a picker, capture or resource read is pending.
			if (!this.supportsImages() && attachments.some(attachment => attachment.kind === 'image')) {
				throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
			}
			this.acceptingContext = true;
			try {
				return this.pasteTarget.addAttachments(attachments, acquisitionSignal);
			} finally {
				this.acceptingContext = false;
			}
		});
	}

	async captureScreenshot(capture?: ChatImageCapture): Promise<void> {
		if (this.isDisposed || !this.visible || this.attachmentModel.hasPendingContext) return;
		const lifecycle = this.inputLifecycle.signal;
		try {
			if (!capture && !this.supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
			const source = this.screenshotContext;
			const attachments = await this.acquireContext(async signal => {
				const selection = await source.asAttachment(undefined, signal, capture);
				if (selection && !this.supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
				return selection ? [selection] : [];
			}, lifecycle);
			if (attachments[0]) announceStatus(localize('chat.context.added', 'Added {0}', attachments[0].name));
		} catch (error) {
			if (!this.isDisposed && !lifecycle.aborted && !isCancellationError(error)) this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error)));
		} finally {
			if (!this.isDisposed && this.visible && !lifecycle.aborted) this.focus();
		}
	}

	/** Reports preparation failures once. Pending submissions still observe the original rejection. */
	async attachFiles(files: readonly File[], signal?: AbortSignal): Promise<void> {
		if (this.isDisposed || !this.visible || files.length === 0) return;
		try {
			await this.acquireContext(draftSignal => createChatFileAttachments(files, draftSignal, () => this.supportsImages(), this.attachmentResolver), signal);
			if (!this.isDisposed && this.visible && !signal?.aborted) announceStatus(localize('chat.context.filesAdded', 'Added {0} attachments', files.length));
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(localize('chat.attach.failed', 'Could not attach files: {0}', String(error)));
		}
	}

	/** Persistence and handoff retain user references; live producer references stay with their owner. */
	protected snapshotDraftReferences(): { text: string; contexts: readonly ChatContextAttachment[]; } {
		let text = this.input.value;
		let attachments = this.contexts.filter(attachment => attachment.lifetime !== 'source');
		// App references belong to their live producer. Removing their labels from the
		// transferred text also shifts the positions of any user references that follow.
		for (const attachment of [...this.contexts].reverse()) {
			if (attachment.lifetime !== 'source' || !attachment.reference) continue;
			const { start, end } = attachment.reference;
			text = text.slice(0, start) + text.slice(end);
			attachments = attachments.map(context => context.reference && context.reference.start >= end ? {
				...context,
				reference: { start: context.reference.start - (end - start), end: context.reference.end - (end - start) },
			} : context);
		}
		return { text, contexts: attachments };
	}

	async captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
		const lifecycle = this.inputLifecycle.signal;
		while (this.attachmentModel.hasPendingContext) {
			await this.attachmentModel.resolvePendingContext();
			if (lifecycle.aborted) return undefined;
		}
		if (this.isDisposed || lifecycle.aborted) return undefined;
		const { text, contexts: attachments } = this.snapshotDraftReferences();
		const mode = this.mode;
		if (!text.trim() && attachments.length === 0) return undefined;
		const revision = this.draftRevision;
		const contexts = await Promise.all(attachments.map(async attachment => ({
			id: attachment.id,
			kind: attachment.kind,
			name: attachment.name,
			content: (await attachment.resolve()).content,
			...(attachment.resource ? { resource: attachment.resource.toString() } : {}),
			...(attachment.terminalSnapshot ? { terminalSnapshot: attachment.terminalSnapshot } : {}),
			...(attachment.reference ? { reference: attachment.reference } : {}),
		})));
		if (this.isDisposed || lifecycle.aborted) return undefined;
		if (this.draftRevision !== revision || this.mode !== mode) throw new Error(localize('chat.draftChangedDuringHandoff', 'The draft changed while opening Agents Window. Try again.'));
		return {
			draft: { mode, text, contexts },
			clear: () => {
				if (this.isDisposed || lifecycle.aborted || this.draftRevision !== revision || this.mode !== mode) return;
				this.setInputValue('');
				this.attachmentModel.cancelPendingContext();
				this.setReferenceState([]);
				this.draftRevision++;
				this.renderToolbar();
				this.inputChanges.fire();
			},
		};
	}

	appendToDraft(text: string): void {
		const previous = this.input.value;
		const suffix = previous ? `\n\n${text}` : text;
		if (suffix) {
			this.logDictationSample(false);
			// Replacing the rich model would retire inline references and their
			// captured snapshots even when their visible labels stay unchanged.
			this.input.setSelection({ anchor: previous.length, active: previous.length });
			this.input.insertText(suffix);
		}
		this.renderToolbar();
	}

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void {
		if (this.input.value || this.contexts.length > 0) throw new Error(localize('chat.draftHandoffConflict', 'The Agents Window already has an unsent draft in this chat.'));
		this.delegate.selectMode(draft.mode);
		this.setInputValue(draft.text);
		const inline: ChatContextAttachment[] = [];
		const legacyReferences: ChatContextAttachment[] = [];
		for (const context of draft.contexts) {
			const attachment: ChatContextAttachment = {
				id: context.id,
				kind: context.kind,
				terminalSnapshot: context.terminalSnapshot,
				name: context.name,
				resource: context.resource ? URI.parse(context.resource) : undefined,
				...(context.reference ? { reference: context.reference } : {}),
				resolve: async () => ({ name: context.name, content: context.content, ...(context.kind === 'image' || context.kind === 'instruction' || context.kind === 'toolSelection' ? { kind: context.kind } : {}) }),
			};
			if (attachment.reference) inline.push(attachment);
			else legacyReferences.push(attachment);
		}
		this.setReferenceState(inline);
		// Older drafts have snapshots without text positions; retain each as a reference at the message end.
		for (const attachment of legacyReferences) this.inlineContext.addReference(attachment, false);
		this.draftRevision++;
		this.renderToolbar();
		this.inputChanges.fire();
	}

	async acceptInput(value?: string): Promise<void> {
		const intent = parseSlashCommandInput(value ?? this.commandText(), this.slashCommands);
		// Local product settings must remain available while the model catalog is loading.
		const localCommand = intent.kind === 'command' && intent.binding.origin === 'local';
		if (this.submitting || this.state.phase === 'submitting' || ((this.state.inputBlocked || this.state.phase === 'loading') && !localCommand)) return;
		if (value !== undefined) {
			const tools = this.contexts.filter(context => context.kind === 'toolSelection');
			this.setInputValue(value);
			this.pasteTarget.addAttachments(tools);
			this.setReferenceState(this.inlineContext.getInputState());
		}
		if (!this.commandText().trim() && !this.attachmentModel.hasPendingContext && !this.contexts.some(attachment => attachment.kind !== 'toolSelection')) return;
		const lifecycle = this.inputLifecycle.signal;
		this.submitting = true;
		this.renderToolbar();
		try {
			if (this.dictationSession.isActive) await this.stopDictation();
			if (this.isDisposed || lifecycle.aborted || !this.visible) return;
			// Prepared files become part of the message. Capture their text and metadata in the same revision.
			if (intent.kind === 'message' && this.attachmentModel.hasPendingMessageContext) {
				let edited = false;
				using listener = this.input.onDidChange(() => { if (!this.acceptingContext) edited = true; });
				await this.attachmentModel.resolvePendingContext();
				// A waiting Send covers prepared references, never subsequent edits to an unsent draft.
				if (edited) return;
			}
			if (this.isDisposed || lifecycle.aborted || !this.visible) return;
			const draft = this.captureHistoryDraft();
			const textRevision = this.textRevision;
			const mode = this.mode;
			const input = parseSlashCommandInput(this.commandText(draft.text, draft.attachments), this.slashCommands);
			// Commands do not submit context. Their settings and management actions remain available during reads.
			const contexts = input.kind === 'message' && this.attachmentModel.hasPendingContext
				? [...new Map([...draft.attachments, ...await this.attachmentModel.resolvePendingContext()].map(attachment => [attachment.id, attachment])).values()] : draft.attachments;
			if (this.isDisposed || lifecycle.aborted || !this.visible) return;
			const localCommand = input.kind === 'command' && input.binding.origin === 'local';
			const currentState = this.state;
			if (currentState.phase === 'submitting' || (currentState.phase === 'loading' && !localCommand)) return;
			if (!this.commandText(draft.text, contexts).trim() && !contexts.some(attachment => attachment.kind !== 'toolSelection')) return;
			if (input.kind === "command" && input.binding.origin === "local") {
				const invocation = { commandId: input.binding.actionId, argumentsText: input.argumentsText };
				await this.submit(draft, textRevision, lifecycle, () => this.delegate.executeCommand(invocation));
				return;
			}
			if (input.kind === "command" && input.binding.origin === "server") {
				await this.submit(draft, textRevision, lifecycle, () => this.delegate.executeServerCommand({ name: input.command.name, argumentsText: input.argumentsText }, lifecycle));
				return;
			}
			if (!this.supportsImages() && contexts.some(attachment => attachment.kind === 'image')) {
				this.notifications.error(localize('chat.image.unsupported', 'The selected model does not support images'));
				return;
			}
			await this.submit(draft, textRevision, lifecycle, () => this.delegate.send(draft.text, mode, draft.skills.length > 0 ? draft.skills : undefined, contexts, lifecycle));
		} finally {
			// An old send must not release the new conversation’s in-flight submission.
			if (!lifecycle.aborted && !this.isDisposed) {
				this.submitting = false;
				this.renderToolbar();
				this.inputChanges.fire();
			}
		}
	}

	invalidatePendingInput(): void {
		this.modePickerActionItem?.hide();
		if (this.input.codeEditor) CopyPasteController.get(this.input.codeEditor)?.clearWidgets();
		const previous = this.inputLifecycle;
		this.inputLifecycle = new AbortController();
		previous.abort();
		this.submitting = false;
		this.attachmentModel.cancelPendingContext();
		this.history.invalidatePending();
		this.historyInputRevision++;
		this.historySearch.clear();
		this.attachContext.clear();
		void this.dictationSession.cancel().catch(error => {
			if (!this.isDisposed) { this.notifications.error(localize('chat.input.dictationFailed', 'Dictation failed: {0}', String(error))); }
		});
	}

	openModelSelector(): void {
		this.modelPickerActionItem.openModelPicker();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.changesPill.setVisible(visible);
		this.updateDictationHost();
		if (visible) {
			this.input.layout();
			this.contextUsageWidget?.update(this.state.contextUsage);
		}
		if (!visible) {
			this.invalidatePendingInput();
			this.contextUsageWidget?.hide();
			this.permissionWidget?.hide();
		}
	}

	private updateDictationHost(): void {
		if (!this.visible) this.dictationHost.clear();
		else if (!this.dictationHost.value) this.dictationHost.value = this.onboarding.registerHost({ container: this.element, focusRoot: this.element, focus: () => this.input.focus() });
	}

	render(state: ChatInputState): void {
		const draftMode = this.selectDraft(state.draftIdentity);
		const restoreMode = draftMode !== undefined && draftMode !== state.mode;
		if (restoreMode) state = { ...state, mode: draftMode };
		if (this.serverSlashCommands !== state.slashCommands) {
			this.slashCommands.setServerCommands(state.slashCommands);
			this.serverSlashCommands = state.slashCommands;
		}
		if (this.skillSelectors !== state.skillSelectors) {
			this.skills.setSkills(state.skillSelectors);
			this.skillSelectors = state.skillSelectors;
		}
		this.state = state;
		this.changesPill.render(state.changes, this.delegate.openChanges !== undefined, state.changesScope, state.changesError);
		this.renderStatus();
		this.renderInteraction(state);
		this.renderToolbar();
		// Publish only after installing the new identity and state: the owner can render synchronously.
		if (restoreMode) this.delegate.selectMode(draftMode);
	}


	/** Layout hosts borrow this composer; changing hosts never copies or consumes its draft. */
	bindDraftStorage(model: IChatWidgetModel, storage: IChatDraftStorage, onWillShutdown: ILifecycleService['onWillShutdown']): void {
		if (this.persistentDrafts) throw new Error('Chat composer already has a draft store');
		this.persistentDrafts = true;
		let threadId = model.threadId;
		let identity = threadId ?? `untitled:${model.untitledSessionId!}`;
		let restoring = false;
		let restoreFailed = false;
		const revisions = new Map<string, number>();
		const pending = new Set<Promise<void>>();
		const restore = (): void => {
			restoreFailed = false;
			try { const draft = storage.read(identity); if (draft) this.restoreDraft(draft); }
			catch (error) {
				restoreFailed = true;
				this.notifications.error(localize('sessions.chat.draftRestoreFailed', 'Could not restore the Chat draft: {0}', String(error)));
			}
		};
		const write = async (): Promise<void> => {
			const draftId = identity;
			const revision = (revisions.get(draftId) ?? 0) + 1;
			revisions.set(draftId, revision);
			const { text, contexts: attachments } = this.snapshotDraftReferences();
			const mode = this.mode;
			if (attachments.length === 0) { storage.write(draftId, { mode, text, contexts: [] }); return; }
			const contexts = await Promise.all(attachments.map(async attachment => ({
				id: attachment.id, kind: attachment.kind, name: attachment.name,
				content: (await attachment.resolve()).content,
				...(attachment.resource ? { resource: attachment.resource.toString() } : {}),
				...(attachment.reference ? { reference: attachment.reference } : {}),
				...(attachment.terminalSnapshot ? { terminalSnapshot: attachment.terminalSnapshot } : {}),
			}))).catch(error => {
				if (revision !== revisions.get(draftId)) return undefined;
				throw error;
			});
			if (contexts && revision === revisions.get(draftId)) storage.write(draftId, { mode, text, contexts });
		};
		const save = (): void => {
			if (restoreFailed || restoring) return;
			const operation = write();
			pending.add(operation);
			void operation.then(() => pending.delete(operation), error => {
				pending.delete(operation);
				if (!this.isDisposed) this.notifications.error(localize('sessions.chat.draftFailed', 'Could not save the Chat draft: {0}', String(error)));
			});
		};
		restoring = true;
		restore();
		restoring = false;
		this._register(this.onDidChangeInput(() => { if (!restoring) { restoreFailed = false; save(); } }));
		this._register(onWillShutdown(event => {
			const snapshot = this.snapshotDraftReferences();
			// An untouched empty composer has no content to protect. In particular,
			// its global storage flush must not veto closing over unrelated UI state.
			if (revisions.size === 0 && !this.attachmentModel.hasPendingContext && snapshot.text.length === 0 && snapshot.contexts.length === 0) return;
			event.join((async () => {
				// File selection can still be preparing its snapshot when the window closes.
				while (this.attachmentModel.hasPendingContext) await this.attachmentModel.resolvePendingContext();
				// A mode switch clears the retained renderer after transferring its draft.
				// Its shutdown must not overwrite the active renderer's persisted input.
				const draft = this.snapshotDraftReferences();
				if (this.visible || draft.text.length > 0 || draft.contexts.length > 0) save();
				await Promise.all([...pending]);
				await storage.flush();
			})(), 'Chat composer draft');
		}));
		this._register(toDisposable(() => {
			for (const [id, revision] of revisions) revisions.set(id, revision + 1);
		}));
		this._register(model.onDidChange(() => {
			if (threadId === model.threadId) return;
			if (threadId !== undefined) {
				save();
				restoring = true;
				this.setInputValue('');
				this.attachmentModel.clear();
			} else {
				// Promotion consumes the untitled identity without creating another composer.
				revisions.set(identity, (revisions.get(identity) ?? 0) + 1);
				storage.write(identity, undefined);
			}
			const changingThread = threadId !== undefined;
			threadId = model.threadId;
			identity = threadId ?? `untitled:${model.untitledSessionId!}`;
			if (changingThread) restore();
			restoring = false;
			save();
		}));
	}

	private selectDraft(identity: ChatInputState['draftIdentity']): ChatInputMode | undefined {
		if (!identity || this.persistentDrafts || this.options.draftStorage === 'host') return;
		const previous = this.draftIdentity;
		this.draftIdentity = identity;
		if (!previous || previous.id === identity.id || previous.generation === identity.generation) return;
		// A retained Session composer lends its live input to one Thread at a time.
		// Park user-owned references with their draft; live App context never follows navigation.
		const snapshot = this.snapshotDraftReferences();
		if (snapshot.text || snapshot.contexts.length) {
			this.conversationDrafts.set(previous.id, { ...this.captureHistoryDraft(), mode: this.mode, text: snapshot.text, attachments: snapshot.contexts });
		} else {
			this.conversationDrafts.delete(previous.id);
		}
		this.invalidatePendingInput();
		this.attachmentModel.clear();
		const draft = this.conversationDrafts.get(identity.id);
		this.conversationDrafts.delete(identity.id);
		this.applyHistoryDraft(draft ?? { text: '', selection: { anchor: 0, active: 0 }, attachments: [], skills: [] });
		this.draftRevision++;
		this.inputChanges.fire();
		return draft?.mode;
	}

	/** Persistent tool configuration labels must not enable Send or obscure a leading slash command. */
	private commandText(text = this.input.value, contexts = this.contexts): string {
		for (const context of [...contexts].reverse()) {
			if (context.kind === 'toolSelection' && context.reference) text = text.slice(0, context.reference.start) + text.slice(context.reference.end);
		}
		return text.trim();
	}

	private renderToolbar(): void {
		const input = parseSlashCommandInput(this.commandText(), this.slashCommands);
		const canSubmitIntent = input.kind === "message" ? input.text.trim().length > 0 || this.attachmentModel.hasPendingContext || this.contexts.some(attachment => attachment.kind !== 'toolSelection') : true;
		const localCommand = input.kind === 'command' && input.binding.origin === 'local';
		const state: ChatInputToolbarState = {
			voiceAvailable: !this.state.aiDisabled && this.delegate.voiceConversation?.isAvailable === true,
			voiceActive: this.delegate.voiceConversation?.isActive === true,
			voiceConnected: this.delegate.voiceConversation?.isConnected === true,
			mode: this.mode,
			canSubmit: canSubmitIntent && !this.submitting && this.state.phase !== 'submitting' && (localCommand || !this.state.inputBlocked && (this.state.phase === 'ready' || this.state.phase === 'error')),
			hasInput: canSubmitIntent,
			canInterrupt: this.state.canInterrupt,
			inputKind: input.kind === "message" ? "message" : "command",
			models: this.state.models,
			selectedModel: this.state.selectedModel,
			selectedReasoningEffort: this.state.selectedReasoningEffort,
			isAutomaticModel: this.state.isAutomaticModel,
			selectedAgent: this.state.selectedAgent,
			agentName: this.state.agentName,
			canSelectAgent: this.state.canSelectAgent,
		};
		if (
			state.voiceAvailable === this.toolbarState.voiceAvailable &&
			state.voiceActive === this.toolbarState.voiceActive &&
			state.voiceConnected === this.toolbarState.voiceConnected &&
			state.mode === this.toolbarState.mode &&
			state.canSubmit === this.toolbarState.canSubmit &&
			state.hasInput === this.toolbarState.hasInput &&
			state.canInterrupt === this.toolbarState.canInterrupt &&
			state.inputKind === this.toolbarState.inputKind &&
			state.models === this.toolbarState.models &&
			sameModel(state.selectedModel, this.toolbarState.selectedModel) &&
			state.selectedReasoningEffort === this.toolbarState.selectedReasoningEffort &&
			state.isAutomaticModel === this.toolbarState.isAutomaticModel &&
			state.selectedAgent?.name === this.toolbarState.selectedAgent?.name &&
			state.selectedAgent?.sourceId === this.toolbarState.selectedAgent?.sourceId &&
			state.agentName === this.toolbarState.agentName &&
			state.canSelectAgent === this.toolbarState.canSelectAgent
		) return;
		if (state.voiceConnected && !this.toolbarState.voiceConnected) announceStatus(localize('chat.voice.connected', 'Voice conversation connected.'));
		else if (state.voiceActive && !this.toolbarState.voiceActive) announceStatus(localize('chat.voice.connecting', 'Connecting voice conversation.'));
		else if (!state.voiceActive && this.toolbarState.voiceActive) announceStatus(localize('chat.voice.stopped', 'Voice conversation stopped.'));
		this.toolbarState = state;
		this.renderToolbarActions();
	}

	private renderToolbarActions(): void {
		const mode = modeOptions.find(option => option.id === this.mode) ?? modeOptions[0]!;
		const modeLabel = this.mode === 'agent' ? this.state.selectedAgent?.name ?? this.state.agentName ?? mode.label : mode.label;
		const modeTooltip = this.mode === 'agent' && modeLabel !== mode.label
			? localize('chat.agentPicker.mode', 'Agent: {0}', modeLabel)
			: localize('chat.modePicker.mode', 'Mode: {0}', modeLabel);
		const modeAction = this.options.modePicker === 'hidden' ? undefined : this.toolbarState.inputKind === "command"
			? new ChatInputAction("ash.chat.input.command", "Command", "Slash command", Lxicon.play, false, "mode", () => { })
			: new SelectorAction(
				"ash.chat.input.mode",
				modeLabel,
				modeTooltip,
				mode.icon,
				"mode",
				async () => {
					let agents: readonly ChatAgent[] = [];
					if (this.state.canSelectAgent) {
						try {
							agents = await this.delegate.listAgents();
						} catch {
							// Built-in modes remain available when custom Agents cannot be listed.
						}
					}
					const options = modeOptions.map(option => new ChatInputAction(
						`ash.chat.input.mode.${option.id}`,
						option.label,
						localize('chat.modePicker.use', 'Use {0} mode', option.label),
						option.icon,
						true,
						"mode",
						() => {
							this.draftRevision++;
							this.delegate.selectMode(option.id);
						},
						option.id === this.mode,
					));
					const agentOptions: IAction[] = [];
					if (this.state.canSelectAgent) {
						const label = localize('chat.agentPicker.default', 'Default Agent');
						agentOptions.push(new ChatInputAction('ash.chat.input.agent.default', label, label, Lxicon.unlimited, true, 'mode', () => this.delegate.selectAgent(undefined), !this.state.selectedAgent));
					} else if (this.state.agentName) {
						agentOptions.push(new ChatInputAction('ash.chat.input.agent.current', this.state.agentName, this.state.agentName, Lxicon.unlimited, false, 'mode', () => { }, true));
					}
					agentOptions.push(...agents.map(agent => new ChatInputAction(
						`ash.chat.input.agent.${agent.sourceId}.${agent.name}`,
						agent.name,
						agent.description,
						undefined,
						true,
						'mode',
						() => this.delegate.selectAgent(agent),
						this.state.selectedAgent?.name === agent.name && this.state.selectedAgent.sourceId === agent.sourceId,
					)));
					return agentOptions.length > 0 ? [...options, new Separator(), ...agentOptions] : options;
				},
			);
		const micAction = this.dictationSession.action;
		let sendAction: ChatInputAction;
		if (this.toolbarState.hasInput) {
			const tooltip = this.toolbarState.inputKind === "command" ? "Run command" : "Send message";
			sendAction = new ChatInputAction("ash.chat.input.send", "Send", tooltip, Lxicon.arrowUp, this.toolbarState.canSubmit, "send", () => this.inputContainer.requestSubmit());
		} else {
			const voice = this.delegate.voiceConversation;
			const label = voice?.isActive ? localize('chat.voice.stop', 'Stop voice conversation') : localize('chat.input.voice', 'Voice conversation');
			sendAction = new ChatInputAction("ash.chat.input.voice", label, voice?.isAvailable || voice?.isActive ? label : localize('chat.input.voiceUnavailable', 'Voice conversation is unavailable'), Lxicon.voiceMode, voice?.isAvailable === true || voice?.isActive === true, "voice", () => voice?.toggle());
		}
		const trailingActions = this.toolbarState.canInterrupt
			? [
				sendAction,
				new ChatInputAction("ash.chat.input.interrupt", "Stop", "Stop response", Lxicon.close, true, "interrupt", () => void this.delegate.interrupt()),
			]
			: [sendAction];
		if (this.delegate.voiceConversation?.isActive) {
			if (this.toolbarState.hasInput) trailingActions.push(new ChatInputAction('ash.chat.input.voiceStop', localize('chat.voice.stop', 'Stop voice conversation'), localize('chat.voice.stop', 'Stop voice conversation'), Lxicon.voiceMode, true, 'voice', () => this.delegate.voiceConversation?.toggle()));
			trailingActions.push(new ChatInputAction('ash.chat.input.voiceInterrupt', localize('chat.voice.interrupt', 'Interrupt voice reply'), localize('chat.voice.interrupt', 'Interrupt voice reply'), Lxicon.close, this.toolbarState.voiceConnected, 'voice', () => this.delegate.voiceConversation?.interrupt()));
		}
		// Localized getters must be evaluated for each presentation; ActionBar retains identical action objects.
		const additionalActions = this.additionalActions.filter(action => action.id !== 'ash.chat.input.attach').map(action => ({ ...action, run: (...args: readonly unknown[]) => action.run(...args) }));
		if (!this.secondaryToolbarContainer) additionalActions.unshift(this.attachAction);
		const modeActions = modeAction ? [modeAction] : [];
		const inputActions = this.toolbarState.inputKind === "command" ? modeActions : [...additionalActions, ...modeActions, this.modelAction, ...(this.dictationSession.showButton ? [micAction] : [])];
		this.inputToolbar.setActions([...inputActions, ...trailingActions]);
		this.modelPickerPresentationChanged.fire();
		this.pickerResponsiveLayout.layout();
	}

	protected supportsImages(): boolean {
		if (this.state.isAutomaticModel) return true;
		const selected = this.state.models.find(entry => entry.model.provider === this.state.selectedModel?.provider && entry.model.model === this.state.selectedModel?.model);
		return selected?.inputModalities == null || selected.inputModalities.includes('image');
	}

	private async stopDictation(): Promise<void> {
		try { await this.dictationSession.stop(); }
		catch (error) {
			if (!this.isDisposed) { this.notifications.error(localize('chat.input.dictationFailed', 'Dictation failed: {0}', String(error))); }
		}
	}

	private createSecondaryToolbar(contextMenus: IContextMenuService, menuService: IMenuService): HTMLElement {
		const container = h(this.element.ownerDocument, 'div');
		container.className = 'ash-chat-secondary-toolbar';
		const owner = this;
		const permissions: IAction = {
			id: 'ash.chat.input.permissions',
			get label() {
				const definition = approvalModeDefinition(owner.state.approvalMode);
				return localize(definition.label.key, definition.label.text);
			},
			get tooltip() { return localize('chat.input.permissionsLabel', 'Permissions: {0}', this.label); },
			get enabled() { return owner.delegate.selectApprovalMode !== undefined; },
			run: async () => this.permissionWidget?.show(),
		};
		const secondaryToolbar = this._register(new MenuWorkbenchToolBar(container, menuService, contextMenus, MenuId.ChatInputSecondary, {
			ariaLabel: localize('chat.input.secondaryActions', 'Chat secondary actions'),
			leadingActions: [this.attachAction, permissions],
			presentation: 'inherit-foreground',
			toolbarOptions: { primaryGroup: () => true },
			actionViewItemProvider: action => {
				if (action.id === this.attachAction.id) return new ChatAttachContextActionViewItem(action, { buttonStyles: defaultButtonStyles });
				if (action !== permissions) return undefined;
				this.permissionWidget = this.instantiationService.createInstance(PermissionPickerActionItem, action, this.footerChanged.event, {
					getActions: () => approvalModeDefinitions.map(definition => ({
						id: definition.id,
						label: localize(definition.label.key, definition.label.text),
						icon: approvalModeIcons[definition.id],
						tooltip: localize(definition.description.key, definition.description.text),
						enabled: permissions.enabled,
						checked: definition.id === this.state.approvalMode,
						run: () => this.runSecondaryAction(async () => {
							if (!this.isDisposed && this.visible) await this.delegate.selectApprovalMode?.(definition.id);
						}),
					})),
				});
				return this.permissionWidget;
			},
		}));
		secondaryToolbar.element.classList.add('ash-chat-secondary-input-toolbar');
		this.createContextUsageToolbar(container, contextMenus);
		this.status.className = 'ash-chat-status-summary';
		container.append(this.status);
		const statusToolbar = this._register(new MenuWorkbenchToolBar(container, menuService, contextMenus, MenuId.ChatInputStatus, {
			ariaLabel: localize('chat.input.statusActions', 'Chat status actions'),
			presentation: 'inherit-foreground',
			// Status indicators stay inline instead of disappearing into More Actions.
			toolbarOptions: { primaryGroup: () => true },
		}));
		statusToolbar.element.classList.add('ash-chat-input-status-toolbar');
		this.renderFooter();
		return container;
	}

	/** Hosts with a custom footer retain the same meter, snapshot and anchored details. */
	protected createContextUsageToolbar(container: HTMLElement, contextMenus: IContextMenuService): void {
		const owner = this;
		this.footerContextAction = {
			id: 'ash.chat.input.contextUsage',
			label: localize('chat.input.contextUsage', 'Context usage'), tooltip: '',
			get enabled() { return owner.state.contextUsage !== undefined; },
			run: () => this.contextUsageWidget?.showDetails(),
		};
		this.footerContextToolbar = this._register(new WorkbenchToolBar(container, contextMenus, {
			ariaLabel: localize('chat.input.contextUsage', 'Context usage'),
			presentation: 'inherit-foreground',
			actionViewItemProvider: action => {
				const widget = this.instantiationService.createInstance(ChatContextUsageWidget, this.element.ownerDocument);
				this.contextUsageWidget = widget;
				return new ChatContextUsageActionViewItem(action, widget);
			},
		}));
		this.footerContextToolbar.element.classList.add('ash-chat-input-context-toolbar');
		this.renderFooter();
	}

	private renderStatus(): void {
		const text = this.statusText(this.state);
		if (this.status.textContent !== text) this.status.textContent = text;
		this.renderFooter();
	}

	private renderFooter(): void {
		if (!this.footerContextToolbar || !this.footerContextAction) return;
		const hasUsage = this.state.contextUsage !== undefined;
		this.footerContextToolbar.setActions(hasUsage ? [this.footerContextAction] : []);
		if (hasUsage) {
			this.contextUsageWidget?.update(this.state.contextUsage);
			if (!this.visible) this.contextUsageWidget?.hide();
		} else {
			this.contextUsageWidget = undefined;
		}
		this.footerContextToolbar.element.hidden = !hasUsage;
		this.footerContextToolbar.element.classList.toggle('empty', !hasUsage);
		this.status.title = this.status.textContent ?? '';
		this.footerChanged.fire();
	}

	private async runSecondaryAction(run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (error) {
			if (!this.isDisposed) {
				this.notifications.error(localize('chat.input.actionFailed', 'Could not open Chat action: {0}', String(error)));
			}
		}
	}

	private createToolbarViewItem(action: IAction, contextViewService: IContextViewService): ActionViewItem | undefined {
		if (action.id === this.attachAction.id) return new ChatAttachContextActionViewItem(action, { buttonStyles: defaultButtonStyles });
		if (action instanceof MenuItemAction && action.id === this.dictationSession.action.id) { return this.instantiationService.createInstance(DictationActionViewItem, action, undefined, this.dictationSession.activeState); }
		if (!(action instanceof ChatInputAction)) return undefined;
		if (action.presentation === 'model') {
			return this.modelPickerActionItem = this.instantiationService.createInstance(ModelPickerActionItem, action, {
				onDidChangePresentation: this.modelPickerPresentationChanged.event,
				getModels: () => this.state.models,
				getSelectedModel: () => this.state.selectedModel,
				getSelectedReasoningEffort: () => this.state.selectedReasoningEffort,
				isAutomaticModel: () => this.state.isAutomaticModel,
				getModelsError: () => this.state.modelsError,
				selectModel: (model: ModelRef) => this.delegate.selectModel(model),
				selectAutomaticModel: () => this.delegate.selectAutomaticModel(),
				selectReasoningEffort: (effort: ModelReasoningEffort | undefined) => this.delegate.selectReasoningEffort(effort),
				openSettings: () => this.delegate.openModelSettings(),
			});
		}
		if (action instanceof SelectorAction) {
			return this.modePickerActionItem = this.instantiationService.createInstance(ModePickerActionItem, action, this.mode, () => {
				const lifetime = this.inputLifecycle.signal;
				return () => !this.isDisposed && !lifetime.aborted && !this.state.aiDisabled;
			}, () => {
				this.renderToolbarActions();
			});
		}
		return new ChatInputButtonViewItem(action);
	}

	private renderInteraction(state: ChatInputState): void {
		const interaction = state.interaction;
		// Streaming and catalog updates must not replace the approval button under keyboard focus.
		if (interaction && interaction === this.renderedInteraction) return;
		this.renderedInteraction = interaction;
		this.interactionListeners.clear();
		this.interaction.replaceChildren();
		if (!interaction) {
			this.interaction.hidden = true;
			return;
		}
		this.interaction.hidden = false;
		const request = interaction.request;
		switch (request.type) {
			case "approval": {
				const reason = h(this.element.ownerDocument, "p");
				reason.textContent = request.request.reason;
				if (request.request.command) {
					const command = h(this.element.ownerDocument, 'pre');
					command.textContent = `${request.request.command.program} ${JSON.stringify(request.request.command.arguments)}`;
					this.interaction.append(command);
				}
				const capabilities = h(this.element.ownerDocument, "ul");
				capabilities.className = "ash-chat-approval-capabilities";
				capabilities.setAttribute('aria-label', localize('chat.approval.targets', 'Requested actions and targets'));
				const labels = {
					fileRead: localize('chat.approval.fileRead', 'Read file'),
					fileWrite: localize('chat.approval.fileWrite', 'Write file'),
					processSpawn: localize('chat.approval.processSpawn', 'Run command'),
					network: localize('chat.approval.network', 'Access network'),
					credentialUse: localize('chat.approval.credentialUse', 'Use credential'),
					externalMutation: localize('chat.approval.externalMutation', 'Change external resource'),
					systemConfiguration: localize('chat.approval.systemConfiguration', 'Change system settings'),
					userInterface: localize('chat.approval.userInterface', 'Control user interface'),
				};
				for (const capability of request.request.capabilities) {
					const item = h(this.element.ownerDocument, "li");
					const label = h(this.element.ownerDocument, "span");
					label.textContent = labels[capability.kind];
					const scope = h(this.element.ownerDocument, "code");
					// The backend owns scope syntax: paths, commands and domains must remain exact.
					scope.textContent = capability.scope;
					item.append(label, this.element.ownerDocument.createTextNode(': '), scope);
					capabilities.append(item);
				}
				const actions = h(this.element.ownerDocument, "div");
				actions.className = "ash-chat-interaction-actions";
				const decline = this.interactionButton(localize('chat.approval.decline', 'Decline'));
				const approve = this.interactionButton(localize('chat.approval.approveOnce', 'Approve once'), true);
				actions.append(decline, approve);
				for (const choice of request.request.allowedDecisions ?? []) {
					if (choice !== 'approveForSession' && choice !== 'approveAndSaveRule') continue;
					const label = choice === 'approveForSession'
						? localize('chat.approval.approveForSession', 'Approve same action this session')
						: localize('chat.approval.saveRule', 'Save approval for this exact action');
					const button = this.interactionButton(label);
					actions.append(button);
					this.interactionListeners.add(addDisposableListener(button, 'click', () => void this.delegate.resolveInteraction({
						type: 'approval', response: { decision: choice },
					}).catch(() => undefined)));
				}

				this.interaction.append(reason, capabilities, actions);
				this.interactionListeners.add(addDisposableListener(decline, "click", () => void this.delegate.resolveInteraction({
					type: "approval",
					response: { decision: "decline" },
				}).catch(() => undefined)));
				this.interactionListeners.add(addDisposableListener(approve, "click", () => void this.delegate.resolveInteraction({
					type: "approval",
					response: { decision: "approveOnce" },
				}).catch(() => undefined)));
				break;
			}
			case "permissions": {
				const form = h(this.element.ownerDocument, 'form');
				form.className = 'ash-chat-interaction-form';
				const heading = h(this.element.ownerDocument, 'p');
				heading.textContent = localize('chat.permissions.environment', 'Permissions in {0}', request.request.environmentId);
				const reason = h(this.element.ownerDocument, 'p');
				reason.textContent = request.request.reason;
				form.append(heading, reason);
				const directories = request.request.directories.map(entry => {
					const group = h(this.element.ownerDocument, 'fieldset');
					const legend = h(this.element.ownerDocument, 'legend');
					legend.textContent = entry.path;
					group.append(legend);
					const permissions = entry.permissions.map(permission => {
						const label = h(this.element.ownerDocument, 'label');
						const input = h(this.element.ownerDocument, 'input');
						input.type = 'checkbox';
						const name = localize({ bundle: 'ash.settings', key: `capabilities.permission.${permission}` }, workspaceTrustPermissionNames[permission]);
						label.append(input, this.element.ownerDocument.createTextNode(name));
						group.append(label);
						return { permission, input };
					});
					form.append(group);
					return { path: entry.path, permissions };
				});
				const hosts = request.request.networkHosts.map(host => {
					const label = h(this.element.ownerDocument, 'label');
					const input = h(this.element.ownerDocument, 'input');
					input.type = 'checkbox';
					label.append(input, this.element.ownerDocument.createTextNode(localize('chat.permissions.networkHost', 'Access network: {0}', host)));
					form.append(label);
					return { host, input };
				});
				const durationLabel = h(this.element.ownerDocument, 'label');
				durationLabel.textContent = localize('chat.permissions.duration', 'Permission duration');
				const duration = h(this.element.ownerDocument, 'select');
				const turnOption = h(this.element.ownerDocument, 'option');
				turnOption.value = 'turn';
				turnOption.textContent = localize('chat.permissions.turn', 'This turn');
				duration.append(turnOption);
				if (request.request.duration === 'session') {
					const sessionOption = h(this.element.ownerDocument, 'option');
					sessionOption.value = 'session';
					sessionOption.textContent = localize('chat.permissions.session', 'This session');
					duration.append(sessionOption);
				}
				durationLabel.append(duration);
				form.append(durationLabel);
				const actions = h(this.element.ownerDocument, 'div');
				actions.className = 'ash-chat-interaction-actions';
				const decline = this.interactionButton(localize('chat.approval.decline', 'Decline'));
				const approve = this.interactionButton(localize('chat.permissions.approveSelected', 'Approve selected'), true);
				approve.type = 'submit';
				actions.append(decline, approve);
				form.append(actions);
				this.interaction.append(form);
				this.interactionListeners.add(addDisposableListener(decline, 'click', () => void this.delegate.resolveInteraction({
					type: 'permissions', response: { duration: 'turn', directories: [], networkHosts: [] },
				}).catch(() => undefined)));
				this.interactionListeners.add(addDisposableListener(form, 'submit', event => {
					event.preventDefault();
					void this.delegate.resolveInteraction({
						type: 'permissions', response: {
							duration: duration.value === 'session' ? 'session' : 'turn',
							directories: directories.map(entry => ({ path: entry.path, permissions: entry.permissions.filter(value => value.input.checked).map(value => value.permission) })).filter(entry => entry.permissions.length > 0),
							networkHosts: hosts.filter(value => value.input.checked).map(value => value.host),
						}
					}).catch(() => undefined);
				}));
				break;
			}
			case "userInput": {
				const form = h(this.element.ownerDocument, "form");
				form.className = "ash-chat-interaction-form";
				const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
				for (const question of request.request.questions) {
					const label = h(this.element.ownerDocument, "label");
					label.textContent = question.question;
					const input = question.options && !question.allowFreeForm ? this.questionSelect(question.options) : h(this.element.ownerDocument, "input");
					input.required = true;
					input.name = question.id;
					label.append(input);
					form.append(label);
					inputs.set(question.id, input);
				}
				const submit = this.interactionButton("Submit", true);
				submit.type = "submit";
				form.append(submit);
				this.interaction.append(form);
				this.interactionListeners.add(addDisposableListener(form, "submit", (event) => {
					event.preventDefault();
					const answers: Record<string, { value: string; }> = {};
					for (const [id, input] of inputs) answers[id] = { value: input.value };
					void this.delegate.resolveInteraction({
						type: "userInput",
						response: { answers },
					}).catch(() => undefined);
				}));
				break;
			}
			case "dynamicTool":
				this.interaction.textContent = `Waiting for dynamic tool: ${request.call.name}`;
				break;
		}
	}

	private interactionButton(label: string, primary = false): HTMLButtonElement {
		const button = h(this.element.ownerDocument, "button");
		button.type = "button";
		button.textContent = label;
		button.className = primary ? "ash-chat-send-button" : "ash-chat-secondary-button";
		return button;
	}

	private questionSelect(options: readonly { readonly label: string; }[]): HTMLSelectElement {
		const select = h(this.element.ownerDocument, "select");
		for (const option of options) {
			const element = h(this.element.ownerDocument, "option");
			element.value = option.label;
			element.textContent = option.label;
			select.append(element);
		}
		return select;
	}

	protected statusText(state: ChatInputState): string {
		if (state.aiDisabled) return localize('chat.ai.disabled.message', 'AI features are disabled. Turn off Disable AI features in Settings to send messages.');
		if (state.inputBlocked && state.phase !== 'loading') return '';
		if (state.error) return state.error;
		if (this.dictationSession.isStarting) return localize('chat.input.dictationStarting', 'Starting dictation…');
		if (this.dictationSession.isActive && this.speechToText.state === ChatSpeechToTextState.Transcribing) return localize('chat.input.dictationTranscribing', 'Transcribing…');
		if (this.dictationSession.isActive) return localize('chat.input.dictationListening', 'Listening…');
		switch (state.phase) {
			case "loading":
				return localize('chat.input.loading', 'Loading chat…');
			case "submitting":
				return localize('chat.input.working', 'Working…');
			case "error":
				return localize('chat.input.unavailable', 'Chat is unavailable.');
			case "ready":
				if (state.queuedMessages > 0) return localize('chat.input.queuedMessages', '{0} messages queued', state.queuedMessages);
				if (state.activeMode && state.activeMode !== state.mode) return localize('chat.input.modeChangeQueued', 'Working in {0}. The next message will be queued in {1} mode.', state.activeMode, state.mode);
				return state.canInterrupt ? localize('chat.input.working', 'Working…') : '';
		}
	}
}

class ChatInputAction implements IAction {
	constructor(
		readonly id: string,
		public label: string,
		public tooltip: string,
		readonly icon: Icon | undefined,
		readonly enabled: boolean,
		readonly presentation: ChatInputToolbarPresentation,
		readonly callback: () => void,
		readonly checked: boolean | undefined = undefined,
	) { }

	run(): void {
		this.callback();
	}
}

class SelectorAction extends ChatInputAction {
	readonly actions: readonly IAction[] | (() => Promise<readonly IAction[]>);

	constructor(id: string, label: string, tooltip: string, icon: Icon | undefined, presentation: "mode" | "model", actions: readonly IAction[] | (() => Promise<readonly IAction[]>), enabled = true) {
		super(id, label, tooltip, icon, enabled, presentation, () => { });
		this.actions = actions;
	}
}

function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
	return left === right || (left !== undefined && right !== undefined && left.provider === right.provider && left.model === right.model);
}

/** Mounts the context widget in the ActionBar's focus and disposal lifecycle. */
class ChatContextUsageActionViewItem extends ActionViewItem {
	constructor(action: IAction, private readonly widget: ChatContextUsageWidget) {
		super(action);
		this._register(widget);
	}

	override render(container: HTMLElement): void {
		container.classList.add('icon');
		container.append(this.widget.domNode);
	}

	override focus(): void { this.widget.domNode.focus(); }

	override setTabbable(tabbable: boolean): void {
		this.widget.domNode.tabIndex = tabbable ? 0 : -1;
	}
}

class ChatAttachContextActionViewItem extends ButtonActionViewItem {
	override render(container: HTMLElement): void {
		super.render(container);
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
		this.button.domNode.setAttribute('aria-expanded', 'false');
	}
}

class ChatInputButtonViewItem extends ButtonActionViewItem {
	private readonly presentation: ChatInputToolbarPresentation;

	constructor(action: ChatInputAction) {
		super(action, { buttonStyles: defaultButtonStyles });
		this.presentation = action.presentation;
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add(`ash-chat-input-${this.presentation}`);
		container.classList.toggle("disabled", !this.action.enabled);
		this.button.toggleClassName("ash-chat-input-action", true);
		this.button.toggleClassName(`ash-chat-input-${this.presentation}-action`, true);
		this.button.toggleClassName("disabled", !this.action.enabled);
	}
}
