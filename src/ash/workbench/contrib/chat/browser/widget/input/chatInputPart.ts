import { ChatToolConfirmationCarouselPart } from '../chatContentParts/toolInvocationParts/chatToolConfirmationCarouselPart.js';
import { ExtensionsInstallConfirmationWidgetSubPart } from '../chatContentParts/toolInvocationParts/chatExtensionsInstallToolSubPart.js';
import { ChatToolAuthenticationSubPart } from '../chatContentParts/toolInvocationParts/chatToolAuthenticationSubPart.js';
import { ChatSandboxPrerequisiteConfirmationSubPart } from '../chatContentParts/toolInvocationParts/chatSandboxPrerequisiteConfirmationSubPart.js';
import { ChatAgentFeedbackReviewConfirmationSubPart } from '../chatContentParts/toolInvocationParts/chatAgentFeedbackReviewConfirmationSubPart.js';
import { ChatModifiedFilesConfirmationSubPart } from '../chatContentParts/toolInvocationParts/chatModifiedFilesConfirmationSubPart.js';
import { ChatOtherClientToolProgressPart } from '../chatContentParts/toolInvocationParts/chatOtherClientToolProgressPart.js';
import { ToolConfirmationSubPart } from '../chatContentParts/toolInvocationParts/chatToolConfirmationSubPart.js';
import { ChatToolPostExecuteConfirmationPart } from '../chatContentParts/toolInvocationParts/chatToolPostExecuteConfirmationPart.js';
import { ChatTerminalToolConfirmationSubPart } from '../chatContentParts/toolInvocationParts/chatTerminalToolConfirmationSubPart.js';
import { BuiltinDynamicCompletions } from './editor/chatInputCompletions.js';
import { InputEditorDecorations } from './editor/chatInputEditorContrib.js';
import { IChatSlashCommandService } from '../../../common/participants/chatSlashCommands.js';
import { IChatService, type QueuedMessage } from '../../../../../services/chat/common/chatService.js';
import type { IChatWidget } from '../../chat.js';
import { InputBox } from '../../../../../../base/browser/ui/inputbox/inputbox.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../../../base/browser/ui/dialog/dialog.js';
import { defaultInputBoxStyles, defaultCheckboxStyles, defaultDialogStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';
import { restoreChatVariableEntry } from '../../../common/attachments/chatVariableEntries.js';
import type { IWorkspacePickerDelegate } from '../../chat.js';
import { WorkspacePickerActionItem } from './workspacePickerActionItem.js';
import { captureChatDraft } from '../../../../../services/chat/common/chatContextService.js';
import { IChatContextService } from '../../contextContrib/chatContextService.js';
import { OPEN_CHAT_PERMISSIONS_COMMAND_ID } from '../../../common/chat.js';
import type { IChatAcceptInputOptions } from '../../chat.js';
import type { IContextKey } from '../../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import type { IChatWidgetModel } from '../chatWidget.js';
import type { ILifecycleService } from '../../../../../services/lifecycle/common/lifecycle.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { Event } from '../../../../../../base/common/event.js';
import { MenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { IImageEditorService } from '../../../../../services/imageEditor/common/imageEditorService.js';
import { convertBufferToScreenshotVariable } from '../../attachments/chatScreenshotContext.js';
import { workspaceTrustPermissionNames } from '../../../../../../platform/workspace/common/workspaceTrust.js';
import { ChatPasteProvidersFeature } from './editor/chatPasteProviders.js';
import { AgentHostInputCompletions, type AgentHostInputCompletionHost } from './editor/agentHostInputCompletions.js';
import { ChatDragAndDrop } from '../chatDragAndDrop.js';
import { CancellationError, isCancellationError } from '../../../../../../base/common/errors.js';
import { ChatInputAction, ChatInputSurface } from './chatInputSurface.js';
import { toErrorMessage } from '../../../../../../base/common/errorMessage.js';
import { ChatChangesPill } from './chatChangesPill.js';
import { ChatWorkingLogo } from '../chatWorkingLogo.js';
import type { SkillReference } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { ChatHistoryNavigator } from '../../../common/widget/chatWidgetHistoryService.js';
import type { MessageHistoryEntry } from '../../../../../../platform/messageHistory/common/messageHistory.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import type { ChatInputEditorSelection } from './chatInputEditorRegistry.js';
import '../media/chat.css';
import { IChatSpeechToTextService, ChatSpeechToTextState } from '../../speechToText/chatSpeechToTextService.js';
import { DictationActionViewItem } from '../../speechToText/dictationActionViewItem.js';
import { IVoiceInputModeService } from '../../voiceInputMode/voiceInputMode.js';
import { AgentsVoiceSettingId } from '../../../../agentsVoice/common/agentsVoice.js';
import { VoiceInputModeActionViewItem, isVoiceInputModeAvailable } from '../../voiceInputMode/voiceInputModeActionViewItem.js';
import { DictationInput } from '../../speechToText/dictationInputController.js';
import { notifyDictationSubmitted } from '../../speechToText/dictationSession.js';
import { IDictationOnboardingService } from '../../speechToText/dictationOnboarding.js';
import { addDisposableListener, h, stopEvent } from '../../../../../../base/browser/dom.js';
import { ActionViewItem, ButtonActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Action, type IAction } from '../../../../../../base/common/actions.js';
import { Separator } from '../../../../../../base/common/actions.js';
import type { Icon } from '../../../../../../base/common/icon.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Emitter, PauseableEmitter } from '../../../../../../base/common/event.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { IMenuService, MenuId } from '../../../../../../platform/actions/common/actions.js';
import { createUuid } from '../../../../../../base/common/uuid.js';
import { AccessibleViewRegistry } from '../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { derived, observableFromEvent, observableValue, type IReader } from '../../../../../../base/common/observable.js';
import { ICanvasContextService } from '../../../../canvases/common/canvas.js';
import { CanvasesPillControl } from '../../../../canvases/browser/canvasesPillControl.js';
import type { IOpenAgentsWindowOptions } from '../../../../../../platform/native/common/nativeHost.js';
import type { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import type { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import type { ModelCatalogEntry } from '../../../../../services/chat/common/chatService.js';
import type { ChatAgent } from '../../../../../services/chat/common/chatService.js';
import { AttachContextAction } from '../../actions/chatContextActions.js';
import { OpenWorkspacePickerAction } from '../../actions/chatExecuteActions.js';
import { createToolSelectionAttachment } from '../../actions/chatToolPicker.js';
import { status as announceStatus } from '../../../../../../base/browser/ui/aria/aria.js';
import { ChatAttachmentModel } from '../../attachments/chatAttachmentModel.js';
import { ChatDynamicVariableModel } from '../../attachments/chatDynamicVariables.js';
import { projectChatDraftReferences } from '../../attachments/chatVariables.js';
import { ChatWidgetPasteTarget } from '../../attachments/chatWidgetPasteTarget.js';
import { createChatFileAttachments, IChatAttachmentResolveService } from '../../attachments/chatAttachmentResolveService.js';
import { CopyPasteController } from '../../../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js';
import type { ModelReasoningEffort } from '../../../../../services/chat/common/modelCatalog.js';
import type { ChatContextAttachment, ChatImageCapture } from '../../../../../services/chat/common/chatContextService.js';
import type { ModelRef } from '../../../../../services/chat/common/chatService.js';
import { DesktopSlashCommands, parseSlashCommandInput, SlashCommandCatalog, type SlashCommandInput } from '../../../common/slashCommands.js';
import { SkillSelectorCatalog } from '../../../common/skillSelectors.js';
import { isChatQuestionAnswerValid } from '../../../common/model/chatQuestionValidation.js';
import type { ChatInputDelegate, ChatInputState } from './chatInput.js';
import { CHAT_INPUT_DEFAULT_MAX_HEIGHT, ChatInputEditors, type ChatInputEditorOptions, type IChatInputEditor, type IChatInputEditorProvider } from './chatInputEditorRegistry.js';
import { ChatInputPickerResponsiveLayout } from './chatInputPickerResponsiveLayout.js';
import {
	chatInputStackClass, chatInputStackSlotClass, ChatInputStackSlot,
	refreshChatInputStack, setChatInputStackInputFocused, setChatInputStackSlot,
} from './chatInputStack.js';
import { ChatInputNoticeHost } from './chatInputNoticeHost.js';
import { IChatInputNoticeHubService } from './chatInputNoticeHub.js';
import { getChatInputAccessibilityHelp } from '../../actions/chatAccessibilityHelp.js';
import { ChatInputNotificationWidget } from './chatInputNotificationWidget.js';
import { ChatInputNotificationActionKind, ChatInputNotificationSeverity, IChatInputNotificationService } from './chatInputNotificationService.js';
import { registerChatInputOnboardingHosts } from './chatInputOnboardingHosts.js';
import { IVoiceModeOnboardingService } from '../../../../agentsVoice/browser/voiceModeOnboarding.js';
import { ModelPickerActionItem } from './modelPicker/modelPickerActionItem.js';
import { approvalModeDefinition, approvalModeDefinitions } from '../../../../../../platform/agentHost/common/approvalModes.js';
import { PermissionPickerActionItem } from './permissionPickerActionItem.js';
import type { IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { ModePickerActionItem, type ChatInputMode } from './modePickerActionItem.js';
import { ChatContextUsageWidget } from '../../widgetHosts/viewPane/chatContextUsageWidget.js';
import { IActionViewItemService } from '../../../../../../platform/actions/browser/actionViewItemService.js';
import { IChatWidgetService } from '../../chat.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { CHAT_SETUP_ACTION_ID } from '../../actions/chatActions.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import type { IMenu } from '../../../../../../platform/actions/common/actions.js';
import { SubmenuItemAction } from '../../../../../../platform/actions/common/actions.js';
import { ChatSubmitAction, type IChatExecuteActionContext } from '../../actions/chatExecuteActions.js';
import { ChatQueueMessageAction, ChatSteerWithMessageAction } from '../../actions/chatQueueActions.js';
import { ChatConfiguration } from '../../../common/constants.js';
import { ChatRequestQueueKind } from '../../../../../services/chat/common/chatService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';

interface ChatInputToolbarState {
	readonly voiceAvailable: boolean;
	readonly voiceActive: boolean;
	readonly voiceConnected: boolean;
	readonly mode: ChatInputMode;
	readonly canSubmit: boolean;
	readonly hasInput: boolean;
	readonly canInterrupt: boolean;
	readonly inputKind: 'message' | 'command';
	readonly models: readonly ModelCatalogEntry[];
	readonly canSelectModel?: boolean;
	readonly selectedModel?: ModelRef;
	readonly selectedReasoningEffort?: ModelReasoningEffort;
	readonly isAutomaticModel: boolean;
	readonly selectedAgent?: ChatAgent;
	readonly agentName?: string;
	readonly canSelectAgent: boolean;
}

const modeOptions: readonly { readonly id: ChatInputMode; readonly label: string; readonly icon?: Icon; }[] = [
	{ id: 'agent', label: 'Agent', icon: Lxicon.unlimited },
	{ id: 'plan', label: 'Plan', icon: Lxicon.plan },
	{ id: 'debug', label: 'Debug', icon: Lxicon.debug },
	{ id: 'multitask', label: 'Multitask', icon: Lxicon.multitask },
	{ id: 'ask', label: 'Ask', icon: Lxicon.ask },
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
	readonly configureModelInMenu?: boolean;
	/** The host supplies its own catalog and model settings when false. */
	readonly useWorkbenchModelManagement?: boolean;
	readonly workspacePickerDelegate?: IWorkspacePickerDelegate;
	/** Keep attachment and dictation or stop beside the editor; submit with Enter and keep configuration below. */
	readonly layout?: 'compact';
	readonly inputLabel?: string;
	readonly inlineEdit?: { readonly descriptionId: string; readonly initialHeight: number; readonly reportError: (error: unknown) => void; };
	readonly renderSecondaryToolbar?: boolean;
	/** Opens a fresh conversation through a model route supplied by the host. */
	/** Host-owned permission policy presented immediately after the mode picker. */
	readonly primaryPermissionPicker?: {
		readonly action: IAction;
		readonly onDidChange: Event<void>;
		readonly actionProvider: IActionWidgetDropdownActionProvider;
	};
	/** Sessions composers already own persisted drafts; the regular input retains them in memory. */
	readonly draftStorage?: 'input' | 'host';
	/** Allows a conversation host to store GitHub references beyond the current draft. */
	readonly attachGitHubReference?: (kind: 'issue' | 'pullRequest', signal: AbortSignal) => Promise<boolean>;
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
	readonly isSubmitting?: boolean;
	readonly changesActionsHost?: HTMLElement;
	readonly composerForm?: HTMLElement;
	createEditor(options: ChatInputEditorOptions): IChatInputEditor;
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
	/** Inserts a source-qualified Skill selector and retains its exact revision for submission. */
	attachSkill(skill: SkillReference): void;
	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void;
	acceptInput(value?: string, options?: IChatAcceptInputOptions): Promise<void>;
	openModelPicker(): void;
	openModePicker(): void;
	openPermissionPicker(): void;
	openWorkspacePicker(): void;
	/** Current model admission shared with registered image context sources. */
	supportsImages(): boolean;
	acceptActiveToolConfirmation(): Promise<void>;
	skipActiveToolConfirmation(): Promise<void>;
	acceptActiveToolPostConfirmation(): Promise<void>;
	skipActiveToolPostConfirmation(): Promise<void>;
	acceptElicitation(): void;
	focusConfirmation(): boolean;
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
	private toolConfirmation: ChatTerminalToolConfirmationSubPart | ChatToolAuthenticationSubPart | undefined;
	readonly noticeHost = this._register(new ChatInputNoticeHost(() => { if (!this.isDisposed && this.visible) this.focus(); }));
	private readonly notificationUri = URI.from({ scheme: 'ash-chat-input', path: `/${createUuid()}` });
	private readonly notificationVisible = observableValue(this, true);
	private readonly noticeRegistration = this._register(new MutableDisposable());
	private readonly dictationOnboardingContainer: HTMLElement;
	private readonly voiceOnboardingContainer: HTMLElement;
	readonly element: HTMLElement;
	private readonly history: ChatHistoryNavigator<InputHistoryDraft>;
	private readonly historySearch = this._register(new MutableDisposable<DisposableStore>());
	private applyingHistory = false;
	private historyInputRevision = 0;
	private draftSkills: { readonly text: string; readonly references: readonly SkillReference[]; } | undefined;
	private persistentDrafts = false;
	private draftIdentity: ChatInputState['draftIdentity'];
	private readonly conversationDrafts = new Map<string, InputHistoryDraft & { readonly mode: ChatInputMode; }>();
	private readonly inputChanges = this._register(new PauseableEmitter<void>({ merge: () => undefined }));
	protected readonly onDidChangeInput = this.inputChanges.event;
	private readonly delegate: ChatInputDelegate;
	private readonly interactionListeners = this._register(new DisposableStore());
	private renderedInteraction: ChatInputState['interaction'];
	private questionDraft: { readonly requestId: string; readonly fields: Map<string, { choice?: number; text: string; }>; } | undefined;
	private renderedToolIdentity: string | undefined;
	private confirmationCarousel: ChatToolConfirmationCarouselPart | undefined;
	private readonly elicitationFocused: IContextKey<boolean>;
	private readonly stagedFiles = this._register(new DisposableStore());
	private readonly stagedFileList?: HTMLElement;
	private filePicker?: HTMLInputElement;
	private applyingModelDraft = false;
	private readonly attachContext = this._register(new MutableDisposable<AttachContextAction>());
	private readonly attachAction = this._register(new Action('ash.chat.input.attach', '', '', true, () => {
		if (this.filePicker) {
			this.filePicker.click();
			return;
		}
		// The command creates the picker owner only when this composer opens it.
		this.attachContext.value ??= this.instantiationService.createInstance(AttachContextAction, {
			container: this.inputContainer, target: this, focusInput: () => this.focus(), supportsImages: () => this.supportsImages(),
			attachGitHubReference: this.options.attachGitHubReference,
		});
		return this.attachContext.value.run(this.element.querySelector<HTMLElement>('[data-action-id="ash.chat.input.attach"] button') ?? undefined);
	}));
	public readonly attachmentModel = this._register(new ChatAttachmentModel());
	private readonly inlineContext: ChatDynamicVariableModel;
	private readonly pasteTarget: ChatWidgetPasteTarget;
	private synchronizingSourceContext = false;
	private readonly status: HTMLDivElement;
	private readonly statusLabel: HTMLSpanElement;
	private readonly workingLogo: ChatWorkingLogo;
	private readonly dictationPreview: HTMLDivElement;
	private readonly interaction: HTMLDivElement;
	protected readonly inputContainer: HTMLFormElement;
	protected readonly input: IChatInputEditor;
	private readonly inputToolbar: WorkbenchToolBar;
	private readonly executeMenu: IMenu;
	private readonly executeContext: IContextKeyService;
	private readonly executeInstantiation: IInstantiationService;
	private readonly queueContextKeys: { hasText: IContextKey<boolean>; running: IContextKey<boolean>; blocked: IContextKey<boolean>; progress: IContextKey<boolean>; };
	private readonly attachmentToolbar: WorkbenchToolBar | undefined;
	private readonly inlineActionsToolbar: WorkbenchToolBar | undefined;
	protected readonly inputFooter: HTMLElement | undefined;
	private readonly changesPill: ChatChangesPill;
	private readonly canvasPills: CanvasesPillControl | undefined;
	private readonly conversation = observableValue<ChatInputState['conversation']>(this, undefined);
	private readonly secondaryToolbarContainer: HTMLElement | undefined;
	private readonly footerChanged = this._register(new Emitter<void>());
	private workspaceWidget: WorkspacePickerActionItem | undefined;
	private workspaceDelegate: IWorkspacePickerDelegate | undefined;
	private workspaceHost: HTMLElement | undefined;
	private readonly workspacePresentation = this._register(new MutableDisposable<WorkspacePickerActionItem>());
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
	private readonly inputDecorations: InputEditorDecorations | undefined;
	private readonly pickerResponsiveLayout: ChatInputPickerResponsiveLayout;
	private readonly slashCommands: SlashCommandCatalog;
	private readonly skills = new SkillSelectorCatalog();
	private state: ChatInputState = { mode: 'agent', queuedMessages: 0, approvalMode: 'manual', phase: 'loading', canInterrupt: false, models: [], isAutomaticModel: false, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	private toolbarState: ChatInputToolbarState = { voiceAvailable: false, voiceActive: false, voiceConnected: false, mode: 'agent', canSubmit: false, hasInput: false, canInterrupt: false, inputKind: 'message', models: [], isAutomaticModel: false, canSelectAgent: false };
	private serverSlashCommands: ChatInputState['slashCommands'] = [];
	private skillSelectors: ChatInputState['skillSelectors'] = [];
	private get mode(): ChatInputMode { return this.state.mode; }
	private readonly dictationSession: DictationInput;
	private readonly onboardingHosts = this._register(new MutableDisposable());
	private dictationSample: { text: string; backend: string; } | undefined;
	private measuringDictation = false;
	private measureWholeDraft = false;
	protected visible = true;
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
		private readonly editorProvider: Pick<IChatInputEditorProvider, 'create'> = ChatInputEditors,
		private readonly additionalActions: readonly IAction[] = [],
		private readonly options: ChatInputPartOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IChatSpeechToTextService private readonly speechToText: IChatSpeechToTextService,
		@IVoiceInputModeService private readonly voiceInputMode: IVoiceInputModeService,
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IMenuService menuService: IMenuService,
		@IChatAttachmentResolveService private readonly attachmentResolver: IChatAttachmentResolveService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IChatInputNoticeHubService private readonly noticeHub: IChatInputNoticeHubService,
		@IChatInputNotificationService private readonly inputNotifications: IChatInputNotificationService,
		@IVoiceModeOnboardingService private readonly voiceOnboarding: IVoiceModeOnboardingService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IActionViewItemService private readonly presentations: IActionViewItemService,
		@IChatWidgetService private readonly chatWidgets: IChatWidgetService,
		@ICommandService private readonly commands: ICommandService,
		@IChatSlashCommandService private readonly clientCommands: IChatSlashCommandService,
		@IImageEditorService private readonly imageEditors: IImageEditorService,
		@IChatContextService private readonly providedContexts: IChatContextService,
	) {
		super();
		// Client commands have their own host-neutral handlers; product and server commands belong to Code.
		this.slashCommands = new SlashCommandCatalog(delegate.executeServerCommand ? DesktopSlashCommands : [], []);
		const ownerDocument = container.ownerDocument;
		this.delegate = delegate;
		this.attachAction.label = delegate.draft ? localize('chat.input.attachFiles', 'Attach files') : localize('chat.context.add', 'Add context');
		this.attachAction.tooltip = this.attachAction.label;
		this.attachAction.icon = Lxicon.add;
		this.slashCommands.setClientCommands(clientCommands.getCommands());
		this._register(clientCommands.onDidChangeCommands(() => this.slashCommands.setClientCommands(clientCommands.getCommands())));
		this.history = this._register(instantiationService.createInstance(ChatHistoryNavigator<InputHistoryDraft>));
		this.element = h(ownerDocument, 'div');
		this.element.className = `ash-chat-input-part ${chatInputStackClass}`;
		container.append(this.element);
		this._register(instantiationService.createInstance(ChatInputNotificationWidget, {
			container: this.element,
			noticeHost: this.noticeHost,
			inputUri: this.notificationUri,
			hostVisible: this.notificationVisible,
			focusInput: () => { if (!this.isDisposed && this.visible) this.focus(); },
			modelSelection: { openPicker: () => this.openModelPicker() },
		}));
		this._register(toDisposable(() => this.clearInputNotifications()));
		this.dictationOnboardingContainer = h(ownerDocument, 'div', { className: `ash-chat-input-notice-slot ${chatInputStackSlotClass}` });
		this.voiceOnboardingContainer = h(ownerDocument, 'div', { className: `ash-chat-input-notice-slot ${chatInputStackSlotClass}` });
		this.element.append(this.voiceOnboardingContainer, this.dictationOnboardingContainer);
		const context = this._register(contextKeys.createScoped(this.element));
		this.executeContext = context;
		this.queueContextKeys = {
			hasText: ChatContextKeys.inputHasText.bindTo(context), running: ChatContextKeys.requestInProgress.bindTo(context),
			blocked: ChatContextKeys.inputBlocked.bindTo(context), progress: ChatContextKeys.transcriptProgressActive.bindTo(context),
		};
		this.executeInstantiation = this._register(instantiationService.createChild(new ServiceCollection([IContextKeyService, context])));
		this.executeMenu = this._register(menuService.createMenu(MenuId.ChatExecute, context));
		const queueDefault = context.createKey(`config.${ChatConfiguration.RequestQueueingDefaultAction}`, configuration.getValue<string>(ChatConfiguration.RequestQueueingDefaultAction) ?? 'steer');
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.RequestQueueingDefaultAction)) queueDefault.set(configuration.getValue<string>(ChatConfiguration.RequestQueueingDefaultAction) ?? 'steer');
			if (event.affectsConfiguration(AgentsVoiceSettingId.ShowButton)) this.renderToolbarActions();
		}));

		const cursorAtTop = ChatContextKeys.inputCursorAtTop.bindTo(context);
		this.status = h(ownerDocument, 'div');
		this.status.className = 'ash-chat-status';
		this.status.setAttribute('role', 'status');
		this.status.hidden = true;
		this.statusLabel = h(ownerDocument, 'span');
		this.workingLogo = this._register(instantiationService.createInstance(ChatWorkingLogo, ownerDocument));
		this.workingLogo.setVisible(false);
		this.status.append(this.workingLogo.domNode, this.statusLabel);
		this.dictationPreview = h(ownerDocument, 'div');
		this.dictationPreview.className = 'ash-chat-dictation-preview';
		this.dictationPreview.setAttribute('aria-hidden', 'true');
		this.dictationPreview.hidden = true;
		this.interaction = h(ownerDocument, 'div');
		this.interaction.className = 'ash-chat-interaction';
		const interactionContext = this._register(context.createScoped(this.interaction));
		this.elicitationFocused = interactionContext.createKey('chatElicitationFocused', false);
		this.interaction.setAttribute('aria-live', 'polite');
		const surface = this._register(new ChatInputSurface(this.element, contextMenuService, {
			createEditor: editorHost => {
				ChatContextKeys.inChatInput.bindTo(this._register(context.createScoped(editorHost))).set(true);
				return editorProvider.create({
					container: editorHost,
					placeholder: options.inlineEdit ? '' : 'Ask Ash',
					ariaLabel: options.inputLabel ?? (options.inlineEdit ? localize('chat.edit.input', 'Edit request') : 'Chat message'),
					ariaDescribedBy: options.inlineEdit?.descriptionId,
					submitWithModifier: options.inlineEdit ? true : undefined,
					tabFocusMode: options.inlineEdit ? true : undefined,
					// Different wrapping in the editor can shorten the message. Keep its
					// original text height so the transcript cannot clamp its scroll position.
					height: options.inlineEdit ? { minimum: options.inlineEdit.initialHeight, maximum: Math.max(CHAT_INPUT_DEFAULT_MAX_HEIGHT, options.inlineEdit.initialHeight) } : undefined,
					slashCommands: this.slashCommands,
					skills: this.skills,
					hostCompletions: true,
				});
			},
			submit: () => {
				if (options.inlineEdit) void this.acceptInput().catch(options.inlineEdit.reportError);
				else if (this.delegate.draft) void this.acceptInput().catch(error => this.notifications.error(error));
				else void this.commands.executeCommand(this.followUpCommand(), this.executionContext()).catch(() => undefined);
			},
			modelPickerPosition: options.modelPickerPosition,
			layout: options.layout,
			compactLayout: options.inlineEdit ? 'stacked' : undefined,
			actionViewItemProvider: action => this.createToolbarViewItem(action, contextViewService),
		}));
		this.inputContainer = surface.form;
		this.inputContainer.classList.add(chatInputStackSlotClass);
		setChatInputStackSlot(this.inputContainer, ChatInputStackSlot.Standalone);
		this.input = surface.editor;
		if (delegate.draft) {
			const filePicker = this.filePicker = h(ownerDocument, 'input');
			filePicker.type = 'file';
			filePicker.multiple = true;
			filePicker.hidden = true;
			this.inputContainer.append(filePicker);
			this._register(addDisposableListener(filePicker, 'change', () => {
				const files = [...filePicker.files ?? []];
				filePicker.value = '';
				void this.attachFiles(files);
			}));
			this.stagedFileList = h(ownerDocument, 'div');
			this.stagedFileList.className = 'ash-chat-staged-files';
			this.stagedFileList.setAttribute('role', 'list');
			this.stagedFileList.setAttribute('aria-label', localize('chat.input.stagedFiles', 'Attachments'));
			this.stagedFileList.setAttribute('aria-live', 'polite');
			this.inputContainer.before(this.stagedFileList);
		}
		this.inputToolbar = surface.toolbar;
		this.attachmentToolbar = surface.attachmentToolbar;
		this.inlineActionsToolbar = surface.inlineActionsToolbar;
		this.inputFooter = surface.footer;
		this.pickerResponsiveLayout = this._register(new ChatInputPickerResponsiveLayout(this.inputToolbar.element));
		const updateCursorAtTop = (): void => cursorAtTop.set(this.input.isAtHistoryBoundary('previous'));
		this._register(this.input.onDidChange(updateCursorAtTop));
		if (this.input.codeEditor) {
			this._register(this.input.codeEditor.onDidChangeCursorSelection(updateCursorAtTop));
			this._register(this.input.codeEditor.onDidLayoutChange(updateCursorAtTop));
		}
		for (const event of ['focusin', 'keyup', 'click'] as const) {
			this._register(addDisposableListener(this.input.element, event, updateCursorAtTop));
		}
		updateCursorAtTop();
		this.inlineContext = this._register(new ChatDynamicVariableModel(this.input, this.attachmentModel));
		this.pasteTarget = this._register(instantiationService.createInstance(ChatWidgetPasteTarget, this.input, this.inlineContext, this.attachmentModel));
		if (this.input.codeEditor) {
			this.inputDecorations = this._register(new InputEditorDecorations(this.input.codeEditor,
				() => this.visible && this.mode === 'agent' && !this.state.aiDisabled ? this.state.selectedAgent : undefined));
			if (!delegate.draft) this._register(instantiationService.createInstance(BuiltinDynamicCompletions, this.input, {
				getAttachments: () => this.contexts,
				getSessionId: () => this.state.conversation?.sessionId,
				acquire: (prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>, signal: AbortSignal) => this.attachmentModel.acquireContext(prepare, AbortSignal.any([signal, this.inputLifecycle.signal]), (attachments) => {
					if (!this.visible) { throw new CancellationError(); }
					if (!this.supportsImages() && attachments.some(attachment => attachment.kind === 'image')) { throw new Error(localize('chat.image.unsupported', 'The selected model does not support images')); }
					for (const attachment of attachments) { this.pasteTarget.addInlineReference(attachment); }
					for (const attachment of attachments) { announceStatus(localize('chat.context.added', 'Added {0}', attachment.name)); }
					return this.contexts;
				}).catch(error => {
					if (!isCancellationError(error)) { this.notifications.error(error); }
					throw error;
				}),
			}));
		}
		if (!delegate.draft && this.input.codeEditor && this.input.getModel) {
			this._register(instantiationService.createInstance(ChatPasteProvidersFeature, this.input, () => this.inputLifecycle.signal, () => this.supportsImages()));
			const completions = this._register(instantiationService.createInstance(AgentHostInputCompletions, this.input.getModel(), {
				currentLifecycle: () => this.inputLifecycle.signal,
				getContext: () => this.state.conversation ?? {},
				acceptSkill: skill => this.captureSkill(skill),
				isEnabled: () => this.visible && !this.state.aiDisabled,
				acceptResource: (resource, isDirectory, replacement, signal) => this.acceptResourceCompletion(resource, isDirectory, replacement, signal),
			} satisfies AgentHostInputCompletionHost));
			completions.register();
		}
		this.secondaryToolbarContainer = options.renderSecondaryToolbar === false
			? undefined
			: this.createSecondaryToolbar(contextMenuService, menuService);
		this.changesPill = this._register(instantiationService.createInstance(ChatChangesPill, this.element, () => {
			void this.runSecondaryAction(async () => { await this.delegate.openChanges?.(this.state.changesRevision); });
		}, () => this.focus(), this.delegate.readWorkspaceChanges));
		const canvasContexts = instantiationService.getOptional(ICanvasContextService);
		if (canvasContexts) {
			this.canvasPills = this._register(instantiationService.createInstance(CanvasesPillControl, this.element, derived((reader: IReader) => {
				const conversation = this.conversation.read(reader);
				return conversation ? canvasContexts.contexts.read(reader).find(context => context.owner.session.path.slice(1) === conversation.sessionId && context.owner.chat.path.slice(1) === conversation.threadId) : undefined;
			}), () => this.focus()));
		}
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 95, name: `chatAttachments-${type}-${createUuid()}`,
				getProvider: () => {
					const focused = this.element.ownerDocument.activeElement as HTMLElement | null;
					const resultReview = focused?.closest<HTMLElement>('.ash-chat-tool-result-review');
					if (resultReview && this.interaction.contains(resultReview) && this.visible && !this.interaction.hidden) {
						return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type },
							() => type === AccessibleViewType.Help ? this.getAccessibilityHelpContent()
								: [resultReview.getAttribute('aria-label'), ...[...resultReview.querySelectorAll('p, pre, button, figcaption')].map(element => element.textContent), ...[...resultReview.querySelectorAll('img')].map(image => image.alt)].filter(Boolean).join('\n'),
							() => focused?.isConnected ? focused.focus() : this.focus(), AccessibilityVerbositySettingId.Chat);
					}
					if (focused && this.canvasPills?.domNode.contains(focused)) {
						const provider = new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type }, () => type === AccessibleViewType.View ? this.canvasPills!.getAccessibleContent() : localize('canvas.pillHelp', 'Canvas buttons open interactive pages from this conversation. Use Tab to reach an Open Canvas or Close Canvas button, and Enter or Space to activate it. Close Canvas ends its page. Closing the editor tab only hides it; use its Canvas button or Open Canvas to reopen it. Canvas actions do not attach content to the message.'), () => focused.isConnected ? focused.focus() : this.focus(), AccessibilityVerbositySettingId.Chat);
						provider.onDidChangeContent = this.canvasPills.onDidChangeContent;
						return provider;
					}
					const agentPreview = focused?.closest<HTMLElement>('.ash-chat-agent-hover');
					if (agentPreview && this.input.codeEditor && agentPreview.dataset.chatInputId === this.input.codeEditor.getId()) {
						return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type },
							() => type === AccessibleViewType.Help ? this.getAccessibilityHelpContent()
								: [...agentPreview.children].map(element => element.textContent).join('\n'),
							() => focused?.isConnected ? focused.focus() : this.focus(), AccessibilityVerbositySettingId.Chat);
					}
					const footerFocused = focused && (this.inputFooter?.contains(focused) || this.secondaryToolbarContainer?.contains(focused));
					const changesFocused = focused && this.changesPill.domNode.contains(focused);
					const referencePreview = focused?.closest<HTMLElement>('.ash-chat-context-reference-preview');
					const previewAttachment = referencePreview && this.inlineContext.variables.find(reference => reference.id === referencePreview.dataset.attachmentId);
					const previewOwned = !!previewAttachment;
					const composerHelpFocused = type === AccessibleViewType.Help && focused && this.element.contains(focused);
					if (!focused || (!composerHelpFocused && !previewOwned && !footerFocused && !changesFocused && !this.input.element.contains(focused) && !this.inputToolbar.element.querySelector('[data-action-id="ash.chat.input.attach"]')?.contains(focused))) { return undefined; }
					if ((footerFocused || changesFocused) && type === AccessibleViewType.View) { return undefined; }
					if (type === AccessibleViewType.View && this.contexts.length === 0) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type }, () => {
						if (previewOwned) {
							if (previewAttachment?.terminalSnapshot) return localize('terminal.chat.previewAccessibility', 'Saved terminal output: {0}\nThis preview is read only and retains the output captured when attached. Press Escape or Close terminal preview to return to the message.\n\n{1}', previewAttachment.name, previewAttachment.terminalSnapshot.text);
							const image = referencePreview!.querySelector('img');
							if (referencePreview!.getAttribute('aria-busy') === 'true') return localize('chat.context.imageLoading', 'Loading preview: {0}', previewAttachment!.name);
							if (!image?.naturalWidth) return localize('chat.context.previewFailed', 'Preview unavailable: {0}', previewAttachment!.name);
							return localize('chat.context.imagePreviewAccessibility', 'Image preview: {0}\nDimensions: {1} × {2}\nPress Escape or activate Close image preview to return. This view identifies the image; it does not describe its contents.', image.alt, image.naturalWidth, image.naturalHeight);
						}
						const names = this.contexts.map(attachment => attachment.name).join('\n');
						return type === AccessibleViewType.View ? names : this.getAccessibilityHelpContent();
					}, () => focused.isConnected ? focused.focus() : this.focus(), AccessibilityVerbositySettingId.Chat);
				},
			}));
		}

		this.dictationSession = this._register(instantiationService.createInstance(DictationInput, this.input, this.dictationPreview, () => this.visible, () => this.delegate.openModelSettings('dictation'), 'chat'));
		this._register(this.voiceInputMode.voiceAvailable.onDidChange(() => this.renderToolbarActions()));
		this._register(this.voiceInputMode.dictationAvailable.onDidChange(() => this.renderToolbarActions()));
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
			if (error) { this.publishDictationError(error); }
		}));
		if (!this.secondaryToolbarContainer) this.element.append(this.status);
		this.element.append(this.dictationPreview, this.interaction, this.changesPill.domNode, this.inputContainer);
		if (this.canvasPills) { this.element.insertBefore(this.canvasPills.domNode, this.changesPill.domNode); }
		if (this.inputFooter && !options.inlineEdit) this.element.append(this.inputFooter);
		if (this.secondaryToolbarContainer) this.element.append(this.secondaryToolbarContainer);
		refreshChatInputStack(this.element);
		this.updateOnboardingHosts();
		this._register(addDisposableListener(this.inputContainer, 'focusin', event => {
			this.inputContainer.classList.add('focused');
			setChatInputStackInputFocused(this.inputContainer, true);
			if (this.input.element.contains(event.target as Node)) {
				const hint = this.accessibleViewService.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
				if (hint) { announceStatus(hint); }
			}
		}));
		this._register(addDisposableListener(this.inputContainer, 'focusout', event => {
			if (this.inputContainer.contains(event.relatedTarget as Node | null)) return;
			this.inputContainer.classList.remove('focused');
			setChatInputStackInputFocused(this.inputContainer, false);
		}));
		this._register(this.input.onDidChange(() => {
			if (!this.applyingModelDraft && this.state.draft?.text !== this.input.value) this.delegate.draft?.setText(this.input.value);
			if (!this.applyingHistory && this.draftSkills) this.draftSkills = { text: this.input.value, references: this.skills.referencesIn(this.input.value, this.draftSkills.references) };
			this.textRevision++;
			this.draftRevision++;
			if (!this.applyingHistory) { this.history.reset(); this.historyInputRevision++; }
			this.inputChanges.fire();
			this.renderStatus();
			this.renderToolbar();
		}));
		if (!options.inlineEdit) this._register(addDisposableListener(this.input.element, 'keydown', event => this.handleHistoryKey(event), true));

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
		this._register(addDisposableListener(this.inputContainer, 'paste', event => {
			const files = [...(event.clipboardData?.files ?? [])];
			if (files.length === 0) return;
			stopEvent(event);
			void this.attachFiles(files);
		}, true));
		this._register(instantiationService.createInstance(ChatDragAndDrop, this, () => this.supportsImages(), () => this.state.conversation))
			.addOverlay(this.inputContainer, this.inputContainer, delegate.draft ? () => this.state.draft?.canAttachFiles === true : undefined);
		this._register(this.executeMenu.onDidChange(() => this.renderToolbarActions()));
		this._register(presentations.onDidChange(menu => { if (menu === MenuId.ChatExecute) this.renderToolbarActions(); }));
		this.renderToolbarActions();
		this._register(toDisposable(() => this.element.remove()));
		this._register(toDisposable(() => this.inputLifecycle.abort()));
		this._register(toDisposable(() => this.conversationDrafts.clear()));
		this._register(toDisposable(() => { this.logDictationSample(false); void this.stopDictation().catch(() => undefined); }));
	}

	protected setHistoryScope(scope: string | undefined): void {
		if (!this.history.setScope(scope)) return;
		this.historyInputRevision++;
		this.historySearch.clear();
	}

	private captureHistoryDraft(): InputHistoryDraft {
		return { text: this.input.value, selection: this.input.getSelection(), attachments: this.contexts, skills: this.draftSkills?.text === this.input.value ? this.draftSkills.references : this.skills.referencesIn(this.input.value) };
	}

	private applyHistoryDraft(draft: InputHistoryDraft): void {
		this.inputChanges.pause();
		this.applyingHistory = true;
		try {
			this.setInputValue(draft.text);
			this.setReferenceState(draft.attachments);
			this.input.setSelection(draft.selection);
			this.draftSkills = { text: draft.text, references: draft.skills };
		} finally {
			this.applyingHistory = false;
			// Draft consumers must observe references and selection together with the restored text.
			if (!this.isDisposed) this.inputChanges.resume();
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
		if (event.key === 'Escape' && this.dictationSession.isActive) {
			stopEvent(event);
			void this.dictationSession.cancel().catch(() => undefined);
			return;
		}
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
		if (this.delegate.draft) {
			// The model consumes the draft only after its backing service accepts it.
			await operation();
			return;
		}
		if (this.options.inlineEdit) {
			this.input.setReadOnly(true);
			try { await operation(); }
			finally { if (!this.isDisposed && !lifecycle.aborted) this.input.setReadOnly(false); }
			return;
		}
		const kind = this.parseInput(this.commandText(draft.text, draft.attachments)).kind === 'command' ? 'command' : 'agent';
		const recordHistory = () => void this.history.record(draft.text, kind).catch(error => {
			if (!this.isDisposed && !lifecycle.aborted) this.notifications.error(localize('chat.history.saveFailed', 'Could not save input history: {0}', String(error)));
		});
		const recordAfterMaterialization = kind === 'agent' && this.history.scope !== undefined && !this.executionContext().widget?.sessionId;
		if (!recordAfterMaterialization) recordHistory();
		// Preparation can finish after the user has started another input; never erase that text.
		const cleared = this.textRevision === textRevision;
		let revision = this.draftRevision;
		if (cleared) {
			this.inputChanges.pause();
			try {
				this.setInputValue('');
				if (this.isDisposed || lifecycle.aborted || !this.visible) return;
				this.setReferenceState([]);
				this.pasteTarget.addAttachments(draft.attachments.filter(context => context.kind === 'toolSelection'));
				// A consumer can start a new draft as soon as the completed clear is published.
				// Its edits must fall outside the revision owned by this request's recovery.
				revision = this.draftRevision;
			} finally {
				if (!this.isDisposed) this.inputChanges.resume();
			}
		}
		this.renderToolbar();
		try {
			// Clearing the editor notifies owners synchronously and can retire this submission.
			if (this.isDisposed || lifecycle.aborted || !this.visible) return;
			await operation();
			if (this.isDisposed || lifecycle.aborted) return;
			if (recordAfterMaterialization && this.history.scope !== undefined) recordHistory();
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

	get isSubmitting(): boolean { return this.submitting; }

	get changesActionsHost(): HTMLElement { return this.changesPill.domNode; }
	get composerForm(): HTMLElement { return this.inputContainer; }

	public createEditor(options: ChatInputEditorOptions): IChatInputEditor {
		return this.editorProvider.create(options);
	}

	addContext(attachment: ChatContextAttachment): void {
		if (attachment.lifetime === 'source') this.attachmentModel.addContext(attachment);
		else {
			this.pasteTarget.addAttachments([attachment]);
			this.focus();
		}
		announceStatus(localize('chat.context.insertedReference', 'Inserted {0} at the message cursor', attachment.name));
	}


	protected get contexts(): readonly ChatContextAttachment[] {
		return this.inlineContext.variables;
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

	private async acceptResourceCompletion(resource: URI, isDirectory: boolean, replacement: { readonly start: number; readonly end: number; }, signal: AbortSignal): Promise<void> {
		const model = this.input.getModel!();
		const version = model.getVersionId();
		const selection = this.input.getSelection();
		const preparation = new AbortController();
		using edits = this.input.onDidChange(() => preparation.abort());
		using cursor = this.input.codeEditor?.onDidChangeCursorSelection(() => preparation.abort());
		const lifetime = AbortSignal.any([signal, preparation.signal]);
		try {
			await this.attachmentModel.acquireContext(
				async draftSignal => [await this.attachmentResolver.resolveResourceAttachContext(resource, isDirectory, draftSignal)],
				lifetime,
				(attachments, acquisitionSignal) => {
					const current = this.input.getSelection();
					if (!this.visible || this.state.aiDisabled || model.getVersionId() !== version || current.anchor !== selection.anchor || current.active !== selection.active) {
						throw new CancellationError();
					}
					if (!this.supportsImages() && attachments.some(attachment => attachment.kind === 'image')) {
						throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
					}
					this.acceptingContext = true;
					try {
						// Stop observing before the accepted reference moves its own cursor.
						edits.dispose();
						cursor?.dispose();
						this.input.setSelection({ anchor: replacement.start, active: replacement.end });
						return this.pasteTarget.addAttachments(attachments, acquisitionSignal);
					} finally {
						this.acceptingContext = false;
					}
				},
			);
		} catch (error) {
			if (!this.isDisposed && !signal.aborted && !isCancellationError(error)) {
				this.notifications.error(localize('chat.context.failed', 'Could not add context: {0}', String(error)));
			}
		}
	}

	async captureScreenshot(capture?: ChatImageCapture): Promise<void> {
		if (this.isDisposed || !this.visible || this.attachmentModel.hasPendingContext) return;
		const lifecycle = this.inputLifecycle.signal;
		try {
			if (!capture && !this.supportsImages()) throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
			const attachments = await this.acquireContext(async signal => {
				const image = await (capture ? capture(signal) : this.imageEditors.capture(signal));
				const selection = image && !signal.aborted ? await convertBufferToScreenshotVariable(image) : undefined;
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
			if (this.delegate.draft) {
				if (this.state.draft?.canAttachFiles && !signal?.aborted) await this.delegate.draft.attachFiles(files);
				return;
			}
			await this.acquireContext(draftSignal => createChatFileAttachments(files, draftSignal, () => this.supportsImages(), this.attachmentResolver), signal);
			if (!this.isDisposed && this.visible && !signal?.aborted) announceStatus(localize('chat.context.filesAdded', 'Added {0} attachments', files.length));
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(localize('chat.attach.failed', 'Could not attach files: {0}', String(error)));
		}
	}

	/** Persistence and handoff retain user references; live producer references stay with their owner. */
	protected snapshotDraftReferences(): { text: string; contexts: readonly ChatContextAttachment[]; } {
		return projectChatDraftReferences(this.input.value, this.contexts);
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
		const draft = await captureChatDraft(text, mode, attachments);
		if (this.isDisposed || lifecycle.aborted) return undefined;
		if (this.draftRevision !== revision || this.mode !== mode) throw new Error(localize('chat.draftChangedDuringHandoff', 'The draft changed while opening Agents Window. Try again.'));
		return {
			draft,
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
			// The transcript restores its reading position as soon as the edit opens.
			// Measure the populated editor before the viewport can clamp to a shorter row.
			if (this.options.inlineEdit) this.input.layout();
		}
		this.renderToolbar();
	}

	attachSkill(skill: SkillReference): void {
		if (this.isDisposed || !this.visible || this.state.aiDisabled) return;
		this.appendToDraft(`$${skill.id.name}`);
		this.captureSkill(skill);
	}

	private captureSkill(skill: SkillReference): void {
		const captured = this.draftSkills?.references.filter(reference => reference.id.name !== skill.id.name) ?? [];
		this.draftSkills = { text: this.input.value, references: this.skills.referencesIn(this.input.value, [...captured, skill]) };
	}

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void {
		if (this.input.value || this.contexts.length > 0) throw new Error(localize('chat.draftHandoffConflict', 'The Agents Window already has an unsent draft in this chat.'));
		this.delegate.selectMode(draft.mode);
		this.setInputValue(draft.text);
		const inline: ChatContextAttachment[] = [];
		const legacyReferences: ChatContextAttachment[] = [];
		for (const context of draft.contexts) {
			const attachment = restoreChatVariableEntry(context);
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

	async acceptInput(value?: string, options?: IChatAcceptInputOptions): Promise<void> {
		if (this.isDisposed || !this.visible) { return; }
		const queue = options?.queue;
		const intent = this.parseInput(value ?? this.commandText());
		if (queue && intent.kind === 'command') {
			throw new Error(localize('chat.queue.messageOnly', 'Queue and steering actions accept messages, not slash commands.'));
		}
		// Local product settings must remain available while the model catalog is loading.
		const localCommand = intent.kind === 'command' && intent.binding.origin === 'local';
		if (this.submitting || this.isSubmissionBlocked(localCommand) || intent.kind === 'command' && intent.binding.origin === 'client' && this.state.canInterrupt && !intent.binding.executeDuringRequest) return;
		if (value !== undefined) {
			const tools = this.contexts.filter(context => context.kind === 'toolSelection');
			this.setInputValue(value);
			this.pasteTarget.addAttachments(tools);
			this.setReferenceState(this.inlineContext.variables);
		}
		// Interim speech is not part of the draft until stopping flushes the transcript.
		if (!this.dictationSession.isActive && !this.commandText().trim() && !this.state.draft?.files.length && !this.attachmentModel.hasPendingContext && !this.contexts.some(attachment => attachment.kind !== 'toolSelection')) return;
		const lifecycle = this.inputLifecycle.signal;
		this.submitting = true;
		this.renderToolbar();
		try {
			if (this.dictationSession.isActive) await this.stopDictation();
			if (this.isDisposed || lifecycle.aborted || !this.visible) return;
			// Prepared files become part of the message. Capture their text and metadata in the same revision.
			if ((intent.kind === 'message' || intent.kind === 'command' && intent.binding.origin === 'client') && this.attachmentModel.hasPendingMessageContext) {
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
			const input = this.parseInput(this.commandText(draft.text, draft.attachments));
			// Speech and prepared context can change the parsed input after initial admission.
			if (queue && input.kind === 'command') {
				throw new Error(localize('chat.queue.messageOnly', 'Queue and steering actions accept messages, not slash commands.'));
			}
			// Commands do not submit context. Their settings and management actions remain available during reads.
			const contexts = (input.kind === 'message' || input.kind === 'command' && input.binding.origin === 'client') && this.attachmentModel.hasPendingContext
				? [...new Map([...draft.attachments, ...await this.attachmentModel.resolvePendingContext()].map(attachment => [attachment.id, attachment])).values()] : draft.attachments;
			// Workspace values are captured at Send, independently of editable draft references and history.
			const requestContexts: readonly ChatContextAttachment[] = !this.options.inlineEdit && !this.delegate.draft && (input.kind === 'message' || input.kind === 'command' && input.binding.origin === 'client')
				? [...contexts, ...this.providedContexts.getWorkspaceContextItems().map(item => ({
					id: item.id, kind: item.kind, name: item.name,
					resolve: async () => ({ name: item.name, content: item.modelDescription ? `${item.modelDescription}\n\n${item.value}` : item.value }),
				}))] : contexts;
			if (this.isDisposed || lifecycle.aborted || !this.visible) return;
			const localCommand = input.kind === 'command' && input.binding.origin === 'local';
			// Preparation can outlast the permission to send. Recheck before consuming the draft or recording history.
			if (this.isSubmissionBlocked(localCommand)) return;
			if (!this.commandText(draft.text, contexts).trim() && !this.state.draft?.files.length && !contexts.some(attachment => attachment.kind !== 'toolSelection')) return;
			if ((input.kind === 'message' || input.kind === 'command' && input.binding.origin === 'client') && !this.supportsImages() && contexts.some(attachment => attachment.kind === 'image')) {
				throw new Error(localize('chat.image.unsupported', 'The selected model does not support images'));
			}
			if (options?.sideChat || input.kind === 'command' && input.binding.origin === 'client') {
				const widget = this.executionContext().widget;
				if (!widget?.sessionId || !widget.threadId) throw new Error(localize('chat.btw.unavailable', 'Send a message in this conversation before starting a side chat.'));
				const offset = input.kind === 'command' ? Math.max(0, draft.text.indexOf(input.argumentsText, input.command.name.length + 1)) : 0;
				const query = draft.text.slice(offset);
				const attachedContext = requestContexts.map(context => context.reference ? { ...context, reference: context.reference.start >= offset ? { start: context.reference.start - offset, end: context.reference.end - offset } : undefined } : context);
				await this.submit(draft, textRevision, lifecycle, () => this.clientCommands.executeCommand(input.kind === 'command' ? input.command.name : 'btw', query, LocalChatSessionUri.forSession(widget.sessionId!, widget.threadId!), { attachedContext, signal: lifecycle }));
				return;
			}
			if (input.kind === 'command' && input.binding.origin === 'local') {
				const invocation = { commandId: input.binding.actionId, argumentsText: input.argumentsText };
				await this.submit(draft, textRevision, lifecycle, () => this.delegate.executeCommand(invocation));
				return;
			}
			if (input.kind === 'command' && input.binding.origin === 'server') {
				await this.submit(draft, textRevision, lifecycle, () => this.delegate.executeServerCommand!({ name: input.command.name, argumentsText: input.argumentsText }, lifecycle));
				return;
			}
			if (!this.supportsImages() && contexts.some(attachment => attachment.kind === 'image')) {
				this.notifications.error(localize('chat.image.unsupported', 'The selected model does not support images'));
				return;
			}
			await this.submit(draft, textRevision, lifecycle, async () => {
				if (options?.cancelCurrentRequest) {
					await this.delegate.interrupt();
					if (this.isDisposed || lifecycle.aborted || !this.visible) throw new CancellationError();
				}
				await this.delegate.send(draft.text, mode, draft.skills.length > 0 ? draft.skills : undefined, requestContexts, lifecycle, queue);
				if (!this.isDisposed && !lifecycle.aborted) this.inputNotifications.handleMessageSent({ inputUri: this.notificationUri });
			});
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
		this.permissionWidget?.hide();
		this.modelPickerActionItem?.hide();
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
		// Retiring capture must not post its eventual failure into the next input lifetime.
		void this.dictationSession.cancel().catch(() => undefined);
	}

	openModelPicker(): void {
		if (this.isDisposed || !this.visible || this.state.aiDisabled) return;
		this.modelPickerActionItem.openModelPicker();
	}

	openModePicker(): void {
		if (this.isDisposed || !this.visible || this.state.aiDisabled || this.options.modePicker === 'hidden' || this.toolbarState.inputKind === 'command') return;
		this.modePickerActionItem?.focus();
		this.modePickerActionItem?.show();
	}

	openPermissionPicker(): void {
		if (this.isDisposed || !this.visible || this.state.aiDisabled) return;
		if (this.permissionWidget) {
			this.permissionWidget.focus();
			this.permissionWidget.show();
		} else {
			// Hosts without a permission trigger already provide the /permission flow.
			void this.runSecondaryAction(() => this.delegate.executeCommand({ commandId: OPEN_CHAT_PERMISSIONS_COMMAND_ID, argumentsText: '' }));
		}
	}

	public openWorkspacePicker(): void {
		if (this.isDisposed || !this.visible || this.state.aiDisabled || this.state.phase === 'submitting') {
			return;
		}
		this.workspaceWidget?.focus();
		this.workspaceWidget?.show();
	}

	/** Compose product help inside this provider so registry priority cannot hide it. */
	protected getAccessibilityHelpContent(): string {
		return [
			getChatInputAccessibilityHelp(this.imageEditors.accessibilityHelp, !!this.secondaryToolbarContainer, !!this.delegate.executeServerCommand || this.clientCommands.getCommands().length > 0),
			this.state.interaction?.request.type === 'toolResultReview' ? localize('chat.resultReview.help', 'This tool has already executed. Tab to Results awaiting review to read its captured output. Share results sends it to the model; Skip results withholds it without undoing changes. Restoring supported file changes is a separate checkpoint operation.') : '',
			this.options.workspacePickerDelegate ? localize('chat.workspace.help', 'The workspace picker chooses the Welcome submission target. In an empty window, use Tab to reach Workspace and Enter, Space or an arrow key to open it, or run Chat: Open Workspace Picker from the Command Palette. Use arrow keys to choose a trusted recent folder or workspace, Enter to select and Escape to return. With a target selected, submitting opens that workspace with the draft and attachments prefilled; it never sends automatically. A failed open keeps your draft.') : '',
			this.contexts.map(attachment => attachment.name).join('\n'),
		].filter(Boolean).join('\n');
	}

	public focusConfirmation(): boolean {
		if (this.isDisposed || !this.visible || this.interaction.hidden) { return false; }
		if (this.confirmationCarousel && !this.interaction.contains(this.interaction.ownerDocument.activeElement)) return this.confirmationCarousel.focusCurrentConfirmation();
		const control = [...this.interaction.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled)')]
			.find(element => !element.closest('[hidden]'));
		if (!control) { return false; }
		if (this.interaction.contains(this.interaction.ownerDocument.activeElement)) { this.focus(); }
		else { control.scrollIntoView({ block: 'nearest' }); control.focus({ preventScroll: true }); }
		return true;
	}

	public acceptActiveToolConfirmation(): Promise<void> { return this.confirmTool('approveOnce'); }
	public skipActiveToolConfirmation(): Promise<void> { return this.confirmTool('decline'); }
	public acceptActiveToolPostConfirmation(): Promise<void> { return this.reviewToolResult('share'); }
	public skipActiveToolPostConfirmation(): Promise<void> { return this.reviewToolResult('skip'); }

	private reviewToolResult(decision: 'share' | 'skip'): Promise<void> {
		const interaction = this.state.interaction;
		if (!interaction || interaction.request.type !== 'toolResultReview') { return Promise.resolve(); }
		return this.resolveInteraction(interaction, { type: 'toolResultReview', response: { decision } });
	}

	private confirmTool(decision: 'approveOnce' | 'decline'): Promise<void> {
		const interaction = this.state.interaction;
		if (!interaction || interaction.request.type !== 'approval' || this.state.aiDisabled || this.state.phase === 'submitting') { return Promise.resolve(); }
		return this.resolveInteraction(interaction, { type: 'approval', response: { decision } });
	}

	public acceptElicitation(): void {
		if (this.isDisposed || !this.visible || this.state.aiDisabled || this.state.phase === 'submitting' || this.state.interaction?.request.type !== 'userInput') { return; }
		this.interaction.querySelector<HTMLFormElement>('form')?.requestSubmit();
	}

	private resolveInteraction(interaction: NonNullable<ChatInputState['interaction']>, response: Parameters<ChatInputDelegate['resolveInteraction']>[0]): Promise<void> {
		if (this.isDisposed || !this.visible || this.state.aiDisabled || this.state.phase === 'submitting'
			|| this.renderedInteraction !== interaction || this.state.interaction !== interaction) {
			return Promise.resolve();
		}
		if (response.type === 'approval') {
			if (this.confirmationCarousel && !this.confirmationCarousel.isCurrentSelected) return Promise.resolve();
			if (interaction.request.type !== 'approval') { return Promise.resolve(); }
			const decisions = interaction.request.request.allowedDecisions ?? ['approveOnce', 'decline'];
			if (!decisions.includes(response.response.decision)) { return Promise.resolve(); }
		}
		return this.delegate.resolveInteraction(response, interaction.requestId);
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.toolConfirmation?.setVisible(visible);
		this.inputDecorations?.update();
		this.changesPill.setVisible(visible);
		this.updateOnboardingHosts();
		this.renderStatus();
		if (visible) {
			this.input.layout();
		}
		if (!visible) {
			this.invalidatePendingInput();
			this.contextUsageWidget?.hide();
			this.permissionWidget?.hide();
			this.workspaceWidget?.hide();
		}
	}

	private updateOnboardingHosts(): void {
		if (!this.visible || this.state.aiDisabled) {
			this.onboardingHosts.clear();
			this.noticeRegistration.clear();
		} else {
			this.noticeRegistration.value ??= this.noticeHub.registerHost(this.noticeHost, this.element);
			this.onboardingHosts.value ??= registerChatInputOnboardingHosts(this.noticeHost,
				{ voice: this.voiceOnboardingContainer, dictation: this.dictationOnboardingContainer }, this.element,
				() => { if (!this.isDisposed && this.visible) this.focus(); }, this.voiceOnboarding, this.onboarding);
		}
	}

	render(state: ChatInputState): void {
		if (state.draftIdentity?.id !== this.state.draftIdentity?.id
			|| state.draftIdentity?.generation !== this.state.draftIdentity?.generation
			|| state.conversation?.sessionId !== this.state.conversation?.sessionId
			|| state.conversation?.threadId !== this.state.conversation?.threadId) {
			this.clearInputNotifications();
			this.renderedInteraction = undefined;
			this.questionDraft = undefined;
		}
		const draftMode = this.selectDraft(state.draftIdentity);
		const restoreMode = draftMode !== undefined && draftMode !== state.mode;
		if (restoreMode) state = { ...state, mode: draftMode };
		if (this.serverSlashCommands !== state.slashCommands) {
			this.slashCommands.setServerCommands(this.delegate.executeServerCommand ? state.slashCommands : []);
			this.serverSlashCommands = state.slashCommands;
		}
		if (this.skillSelectors !== state.skillSelectors) {
			this.skills.setSkills(state.skillSelectors);
			this.skillSelectors = state.skillSelectors;
		}
		const previousDraft = this.state.draft;
		this.state = state;
		if (state.draft) {
			if (previousDraft?.readOnly === false && state.draft.readOnly) {
				void this.dictationSession.cancel().catch(() => undefined);
			}
			this.input.setReadOnly(state.draft.readOnly);
			this.attachAction.enabled = state.draft.canAttachFiles;
			if (state.draft.text !== this.input.value) {
				this.applyingModelDraft = true;
				try { this.setInputValue(state.draft.text); }
				finally { this.applyingModelDraft = false; }
			}
			if (previousDraft?.files !== state.draft.files || previousDraft.readOnly !== state.draft.readOnly) this.renderStagedFiles();
		}
		this.inputDecorations?.update();
		this.updateOnboardingHosts();
		this.conversation.set(state.conversation, undefined);
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
	private parseInput(text: string): SlashCommandInput {
		if (this.options.inlineEdit) return { kind: 'message', text };
		const input = parseSlashCommandInput(text, this.slashCommands);
		return this.delegate.executeServerCommand || input.kind === 'command' && input.binding.origin === 'client' ? input : { kind: 'message', text };
	}

	private commandText(text = this.input.value, contexts = this.contexts): string {
		for (const context of [...contexts].reverse()) {
			if (context.kind === 'toolSelection' && context.reference) text = text.slice(0, context.reference.start) + text.slice(context.reference.end);
		}
		return text.trim();
	}

	private renderStagedFiles(): void {
		const list = this.stagedFileList;
		const state = this.state.draft;
		const draft = this.delegate.draft;
		if (!list || !state || !draft) return;
		const focused = list.ownerDocument.activeElement;
		const focusedFile = focused instanceof HTMLElement && list.contains(focused) ? focused.closest<HTMLElement>('[data-file-id]')?.dataset.fileId : undefined;
		this.stagedFiles.clear();
		list.replaceChildren();
		list.hidden = !state.files.length;
		for (const file of state.files) {
			const row = h(list.ownerDocument, 'div', { className: 'ash-chat-staged-file', attributes: { role: 'listitem' }, dataset: { fileId: file.id } });
			const status = file.status === 'uploading' ? localize('chat.input.fileUploading', 'Uploading…')
				: file.status === 'failed' ? localize('chat.input.fileUploadFailed', 'Upload failed') : localize('chat.input.fileReady', 'Ready');
			row.append(h(list.ownerDocument, 'span', { className: 'ash-chat-staged-file-name' }, file.name), h(list.ownerDocument, 'span', {}, status));
			if (file.error) row.append(h(list.ownerDocument, 'div', {}, file.error));
			if (file.status === 'failed') {
				const retry = this.stagedFiles.add(new Button(row, { ...defaultButtonStyles, label: localize('chat.input.retryFile', 'Retry {0}', file.name), size: 'small', presentation: 'quiet' }));
				retry.enabled = !state.readOnly;
				this.stagedFiles.add(retry.onDidClick(() => { this.focus(); void draft.retryFile(file.id).catch(error => this.notifications.error(error)); }));
			}
			const remove = this.stagedFiles.add(new Button(row, { ...defaultButtonStyles, label: localize('chat.input.removeFile', 'Remove {0}', file.name), size: 'small', presentation: 'quiet' }));
			remove.enabled = !state.readOnly;
			this.stagedFiles.add(remove.onDidClick(() => { this.focus(); draft.removeFile(file.id); }));
			list.append(row);
			if (focusedFile === file.id && !state.readOnly) remove.focus();
		}
	}

	private isSubmissionBlocked(localCommand: boolean): boolean {
		return this.state.phase === 'submitting' || (!localCommand && (this.state.inputBlocked === true || this.state.phase === 'loading'));
	}

	private renderToolbar(): void {
		const input = this.parseInput(this.commandText());
		const canSubmitIntent = this.options.inlineEdit ? input.kind === 'message' && !!input.text.trim() : input.kind === 'message' ? input.text.trim().length > 0 || !!this.state.draft?.files.length || this.attachmentModel.hasPendingContext || this.contexts.some(attachment => attachment.kind !== 'toolSelection') : true;
		const localCommand = input.kind === 'command' && input.binding.origin === 'local';
		const state: ChatInputToolbarState = {
			voiceAvailable: !this.state.aiDisabled && this.delegate.voiceConversation?.isAvailable === true,
			voiceActive: this.delegate.voiceConversation?.isActive === true,
			voiceConnected: this.delegate.voiceConversation?.isConnected === true,
			mode: this.mode,
			canSubmit: canSubmitIntent && !this.submitting && !this.isSubmissionBlocked(localCommand) && !(input.kind === 'command' && input.binding.origin === 'client' && this.state.canInterrupt && !input.binding.executeDuringRequest),
			hasInput: canSubmitIntent,
			canInterrupt: this.state.canInterrupt,
			inputKind: input.kind === 'message' ? 'message' : 'command',
			models: this.state.models,
			canSelectModel: this.state.canSelectModel,
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
			state.canSelectModel === this.toolbarState.canSelectModel &&
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
		this.executeContext.bufferChangeEvents(() => {
			this.queueContextKeys.hasText.set(state.hasInput && state.inputKind === 'message');
			this.queueContextKeys.running.set(state.canInterrupt);
			this.queueContextKeys.blocked.set(!state.canSubmit);
			this.queueContextKeys.progress.set(this.state.inputBlocked === true);
		});
		this.renderToolbarActions();
	}

	private renderToolbarActions(): void {
		const mode = modeOptions.find(option => option.id === this.mode) ?? modeOptions[0]!;
		const modeLabel = this.mode === 'agent' ? this.state.selectedAgent?.name ?? this.state.agentName ?? mode.label : mode.label;
		const modeTooltip = this.mode === 'agent' && modeLabel !== mode.label
			? localize('chat.agentPicker.mode', 'Agent: {0}', modeLabel)
			: localize('chat.modePicker.mode', 'Mode: {0}', modeLabel);
		const modeAction = this.options.modePicker === 'hidden' ? undefined : this.toolbarState.inputKind === 'command'
			? new ChatInputAction('ash.chat.input.command', 'Command', 'Slash command', Lxicon.play, false, 'mode', () => { })
			: new SelectorAction(
				'ash.chat.input.mode',
				modeLabel,
				modeTooltip,
				mode.icon,
				'mode',
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
						'mode',
						() => {
							this.draftRevision++;
							if (option.id === 'agent' && this.state.canSelectAgent && this.state.selectedAgent) {
								this.delegate.selectAgent(undefined);
							}
							this.delegate.selectMode(option.id);
						},
						option.id === this.mode && (option.id !== 'agent' || !this.state.canSelectAgent || !this.state.selectedAgent),
					));
					const agentOptions: IAction[] = [];
					if (!this.state.canSelectAgent && this.state.agentName) {
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
		const voice = this.delegate.voiceConversation;
		const segmentedVoice = !this.inlineActionsToolbar && !this.state.aiDisabled && (voice?.isAvailable || voice?.isActive) &&
			(isVoiceInputModeAvailable(this.voiceInputMode) === 'both' || this.voiceInputMode.voiceAvailable.get() && voice?.isConnected);
		const trailingActions: IAction[] = [];
		const executionActions = this.options.inlineEdit || this.delegate.draft ? [] : this.executeMenu.getActions({ arg: this.executionContext() }).flatMap(([, actions]) => actions);
		const keepSendVisible = this.inlineActionsToolbar && !this.delegate.draft && !this.toolbarState.canInterrupt && !voice?.isActive;
		const canSubmitDictation = !!this.delegate.draft && this.dictationSession.isActive && !this.submitting && !this.isSubmissionBlocked(false);
		if (executionActions.length) {
			trailingActions.push(...executionActions);
		} else if (this.toolbarState.hasInput || keepSendVisible || canSubmitDictation) {
			const label = this.options.inlineEdit ? localize('chat.edit.resend', 'Send edited request') : localize('chat.input.send', 'Send');
			const tooltip = this.options.inlineEdit ? label : this.toolbarState.inputKind === 'command' ? localize('chat.input.runCommand', 'Run command') : localize('chat.input.sendMessage', 'Send message');
			trailingActions.push(new ChatInputAction('ash.chat.input.send', label, tooltip, Lxicon.arrowUp, this.toolbarState.canSubmit || canSubmitDictation, 'send', () => this.inputContainer.requestSubmit()));
		} else if ((!this.inlineActionsToolbar || this.delegate.draft && !voice?.isActive) && !segmentedVoice && this.configuration.getValue<boolean>(AgentsVoiceSettingId.ShowButton) !== false) {
			const label = voice?.isActive ? localize('chat.voice.stop', 'Stop voice conversation') : localize('chat.input.voice', 'Voice conversation');
			trailingActions.push(new ChatInputAction('ash.chat.input.voice', label, voice?.isAvailable || voice?.isActive ? label : localize('chat.input.voiceUnavailable', 'Voice conversation is unavailable'), Lxicon.voiceMode, voice?.isAvailable === true || voice?.isActive === true, 'voice', () => voice?.toggle()));
		}
		if (this.toolbarState.canInterrupt) {
			const label = this.state.interruptKind === 'reply' ? localize('chat.input.stopReply', 'Stop') : localize('chat.input.stopTask', 'Stop task');
			trailingActions.push(new ChatInputAction('ash.chat.input.interrupt', label, label, this.inlineActionsToolbar ? Lxicon.stopCircle : Lxicon.close, true, this.inlineActionsToolbar ? 'mic' : 'interrupt', () => void this.interrupt()));
		}
		if (this.delegate.voiceConversation?.isActive) {
			if (this.inlineActionsToolbar) {
				if (!this.toolbarState.canInterrupt) trailingActions.push(new ChatInputAction('ash.chat.input.voiceStop', localize('chat.voice.stop', 'Stop voice conversation'), localize('chat.voice.stop', 'Stop voice conversation'), Lxicon.stopCircle, true, 'mic', () => this.delegate.voiceConversation?.toggle()));
			} else {
				if (this.toolbarState.hasInput && !segmentedVoice) trailingActions.push(new ChatInputAction('ash.chat.input.voiceStop', localize('chat.voice.stop', 'Stop voice conversation'), localize('chat.voice.stop', 'Stop voice conversation'), Lxicon.voiceMode, true, 'voice', () => this.delegate.voiceConversation?.toggle()));
				trailingActions.push(new ChatInputAction('ash.chat.input.voiceInterrupt', localize('chat.voice.interrupt', 'Interrupt voice reply'), localize('chat.voice.interrupt', 'Interrupt voice reply'), Lxicon.close, this.toolbarState.voiceConnected, 'voice', () => this.delegate.voiceConversation?.interrupt()));
			}
		}
		// Localized getters must be evaluated for each presentation; ActionBar retains identical action objects.
		const additionalActions = this.additionalActions.filter(action => action.id !== 'ash.chat.input.attach').map(action => ({ ...action, run: (...args: readonly unknown[]) => action.run(...args) }));
		if (!this.secondaryToolbarContainer && !this.attachmentToolbar) additionalActions.unshift(this.attachAction);
		const modeActions: IAction[] = modeAction ? [modeAction] : [];
		if (this.options.primaryPermissionPicker) modeActions.push(this.options.primaryPermissionPicker.action);
		const dictationActions: IAction[] = [];
		if (segmentedVoice) {
			dictationActions.push(new ChatInputAction(
				'workbench.action.chat.voiceInputMode', localize('chat.input.voice', 'Voice conversation'), '', Lxicon.voiceMode,
				voice?.isActive === true || !this.speechToText.isBusy || this.dictationSession.isActive, 'voice', () => this.toggleVoiceInput(),
			));
		} else if (this.dictationSession.showButton) {
			dictationActions.push(micAction);
		}
		const inputActions = this.options.inlineEdit ? [] : this.toolbarState.inputKind === 'command' ? modeActions : [...additionalActions, ...modeActions, this.modelAction, ...(this.inlineActionsToolbar ? [] : dictationActions)];
		this.attachmentToolbar?.setActions([this.attachAction]);
		const showInlineDictation = trailingActions.length === 0
			|| executionActions.length === 0 && !this.toolbarState.canInterrupt && !voice?.isActive;
		this.inlineActionsToolbar?.setActions(showInlineDictation ? [...dictationActions, ...trailingActions] : trailingActions);
		this.inputToolbar.setActions(this.inlineActionsToolbar ? inputActions : [...inputActions, ...trailingActions]);
		this.modelPickerPresentationChanged.fire();
		this.pickerResponsiveLayout.layout();
	}

	public supportsImages(): boolean {
		if (this.state.isAutomaticModel) return true;
		const selected = this.state.models.find(entry => entry.model.provider === this.state.selectedModel?.provider && entry.model.model === this.state.selectedModel?.model);
		return selected?.inputModalities == null || selected.inputModalities.includes('image');
	}

	private async toggleVoiceInput(): Promise<void> {
		const voice = this.delegate.voiceConversation;
		if (!voice || this.state.aiDisabled) {
			return;
		}
		const lifetime = this.inputLifecycle.signal;
		if (!voice.isActive && this.dictationSession.isActive) {
			await this.dictationSession.cancel();
		}
		if (this.isDisposed || lifetime.aborted || !this.visible || this.state.aiDisabled) {
			return;
		}
		await voice.toggle();
	}

	private async toggleInputDictation(): Promise<void> {
		const lifetime = this.inputLifecycle.signal;
		if (this.delegate.voiceConversation?.isActive) {
			await this.delegate.voiceConversation.toggle();
		}
		if (this.isDisposed || lifetime.aborted || !this.visible || this.state.aiDisabled) {
			return;
		}
		await this.dictationSession.action.run();
	}

	private async stopDictation(): Promise<void> {
		const lifetime = this.inputLifecycle.signal;
		try { await this.dictationSession.stop(); }
		catch (error) {
			if (!lifetime.aborted) this.publishDictationError(error);
			throw error;
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
		this.workspaceHost = h(container.ownerDocument, 'div', { className: 'ash-chat-input-workspace-slot' });
		container.append(this.workspaceHost);

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

	protected renderStatus(): void {
		const text = this.statusText(this.state);
		const showNotifications = !this.state.aiDisabled && (!this.state.inputBlocked || !!this.delegate.draft);
		const error = showNotifications && (this.state.error || (this.state.phase === 'error' ? text : ''));
		this.notificationVisible.set(this.visible && showNotifications, undefined);
		if (error) {
			this.inputNotifications.setNotification({
				id: this.notificationId('model'), inputUri: this.notificationUri,
				severity: ChatInputNotificationSeverity.Error, message: error,
				actions: [], dismissible: false, autoDismissOnMessage: false,
			}, { inPlace: true });
		} else {
			this.inputNotifications.deleteNotification(this.notificationId('model'));
		}
		if (this.state.modelsError) {
			this.inputNotifications.setNotification({
				id: this.notificationId('catalog'), inputUri: this.notificationUri,
				severity: ChatInputNotificationSeverity.Warning, message: this.state.modelsError,
				actions: [
					{ kind: ChatInputNotificationActionKind.OpenModelPicker, label: localize('chat.notice.chooseModel', 'Choose a model') },
					{ kind: ChatInputNotificationActionKind.Command, commandId: CHAT_SETUP_ACTION_ID, label: localize('chat.setup.action', 'Set Up Chat') },
				],
				dismissible: true, autoDismissOnMessage: true,
			}, { inPlace: true });
		} else {
			this.inputNotifications.deleteNotification(this.notificationId('catalog'));
		}
		const summary = error ? '' : text;
		if (this.statusLabel.textContent !== summary) this.statusLabel.textContent = summary;
		this.status.hidden = !summary;
		const working = !this.state.aiDisabled && !this.state.inputBlocked && !error
			&& (this.state.phase === 'submitting' || this.state.phase === 'ready' && this.state.canInterrupt);
		this.workingLogo.setVisible(this.visible && working && !!summary);
		this.workingLogo.setActive(working);
		this.renderFooter();
	}

	private notificationId(source: 'model' | 'catalog' | 'dictation'): string {
		return `${this.notificationUri.toString()}/${source}`;
	}

	private clearInputNotifications(): void {
		for (const source of ['model', 'catalog', 'dictation'] as const) this.inputNotifications.deleteNotification(this.notificationId(source));
	}

	private publishDictationError(error: unknown): void {
		if (this.isDisposed || !this.visible || this.state.aiDisabled) return;
		this.inputNotifications.setNotification({
			id: this.notificationId('dictation'), inputUri: this.notificationUri,
			severity: ChatInputNotificationSeverity.Error,
			message: localize('chat.input.dictationFailed', 'Dictation failed: {0}', String(error)),
			actions: [{ kind: ChatInputNotificationActionKind.Command, commandId: 'workbench.action.chat.showSpeechToTextIntroduction', label: localize('chat.notice.dictationIntroduction', 'Show dictation introduction') }],
			dismissible: true, autoDismissOnMessage: true,
		});
	}

	private renderWorkspacePicker(): void {
		if (!this.workspaceHost) { return; }
		const delegate = this.options.workspacePickerDelegate;
		this.workspaceHost.hidden = !delegate;
		if (delegate !== this.workspaceDelegate) {
			this.workspacePresentation.clear();
			this.workspaceDelegate = delegate;
			this.workspaceWidget = undefined;
			if (delegate) {
				const owner = this;
				const picker = this.instantiationService.createInstance(WorkspacePickerActionItem, {
					id: OpenWorkspacePickerAction.ID, label: localize('chat.workspace.label', 'Workspace'),
					tooltip: localize('chat.workspace.choose', 'Choose a workspace'), icon: Lxicon.folder,
					get enabled() { return !owner.state.aiDisabled && owner.state.phase !== 'submitting'; },
					run: () => this.openWorkspacePicker(),
				}, delegate, this.footerChanged.event);
				this.workspacePresentation.value = this.workspaceWidget = picker;
				picker.render(this.workspaceHost);
			}
		}
		if (!this.visible || this.state.aiDisabled || this.state.phase === 'submitting') { this.workspaceWidget?.hide(); }
	}

	private renderFooter(): void {
		this.renderWorkspacePicker();
		if (!this.footerContextToolbar || !this.footerContextAction) return;
		const showWhenEmpty = this.options.layout === 'compact';
		const showMeter = showWhenEmpty || this.state.contextUsage !== undefined;
		this.footerContextToolbar.setActions(showMeter ? [this.footerContextAction] : []);
		if (showMeter) {
			this.contextUsageWidget?.update(this.state.contextUsage, showWhenEmpty);
			if (!this.visible) this.contextUsageWidget?.hide();
		} else {
			this.contextUsageWidget = undefined;
		}
		this.footerContextToolbar.element.hidden = !showMeter;
		this.footerContextToolbar.element.classList.toggle('empty', !showMeter);
		this.status.title = this.status.textContent ?? '';
		this.footerChanged.fire();
	}

	private async interrupt(): Promise<void> {
		const lifecycle = this.inputLifecycle.signal;
		try {
			await this.delegate.interrupt();
		} catch (error) {
			if (!this.isDisposed && !lifecycle.aborted && !isCancellationError(error)) this.notifications.error(toErrorMessage(error));
		}
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
		const permissions = this.options.primaryPermissionPicker;
		if (permissions && action === permissions.action) {
			return this.permissionWidget = this.instantiationService.createInstance(PermissionPickerActionItem, action, permissions.onDidChange, permissions.actionProvider);
		}
		if (action.id === 'workbench.action.chat.voiceInputMode') {
			return this.instantiationService.createInstance(VoiceInputModeActionViewItem, action, {
				toggleDictation: () => void this.runSecondaryAction(() => this.toggleInputDictation()),
				isDictationActive: this.dictationSession.activeState,
				isVoiceActive: observableFromEvent(this, this.modelPickerPresentationChanged.event, () => this.delegate.voiceConversation?.isActive === true),
			});
		}
		if (action instanceof SubmenuItemAction) {
			const factory = this.presentations.lookUp(MenuId.ChatExecute, action.item.submenu);
			if (factory) return factory(action, { buttonStyles: defaultButtonStyles, actionContext: this.executionContext() }, this.executeInstantiation, 0);
		}
		if (action.id === this.attachAction.id) return new ChatAttachContextActionViewItem(action, { buttonStyles: defaultButtonStyles });
		if (action instanceof MenuItemAction && action.id === this.dictationSession.action.id) { return this.instantiationService.createInstance(DictationActionViewItem, action, undefined, this.dictationSession.activeState); }
		if (!(action instanceof ChatInputAction)) return undefined;
		if (action.presentation === 'model') {
			return this.modelPickerActionItem = this.instantiationService.createInstance(ModelPickerActionItem, action, {
				configureInMenu: this.options.configureModelInMenu,
				useWorkbenchModelManagement: this.options.useWorkbenchModelManagement,
				onDidChangePresentation: this.modelPickerPresentationChanged.event,
				getModels: () => this.state.models,
				canSelectModel: () => this.state.canSelectModel !== false,
				getSelectedModel: () => this.state.selectedModel,
				getSelectedReasoningEffort: () => this.state.selectedReasoningEffort,
				isAutomaticModel: () => this.state.isAutomaticModel,
				getModelsError: () => this.state.modelsError,
				selectModel: (model: ModelRef) => this.delegate.selectModel(model),
				selectAutomaticModel: this.delegate.selectAutomaticModel,
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
			}, () => this.mode === 'agent' && !this.state.aiDisabled ? this.state.selectedAgent : undefined);
		}
		return undefined;
	}

	private executionContext(): IChatExecuteActionContext {
		return { widget: this.chatWidgets.getAllWidgets().find(widget => widget.input === this) };
	}

	private followUpCommand(): string {
		if (!this.state.canInterrupt || this.toolbarState.inputKind !== 'message') return ChatSubmitAction.ID;
		const editing = this.executeContext.getValue(ChatContextKeys.editingRequestType.key);
		const queue = editing === ChatContextKeys.EditingRequestType.Queue || editing !== ChatContextKeys.EditingRequestType.Steer && this.configuration.getValue<string>(ChatConfiguration.RequestQueueingDefaultAction) === 'queue';
		return queue ? ChatQueueMessageAction.ID : ChatSteerWithMessageAction.ID;
	}

	private renderInteraction(state: ChatInputState): void {
		const interaction = state.interaction;
		const questionRequestId = interaction?.request.type === 'userInput' ? interaction.requestId : state.pendingUserInputRequestId;
		if (this.questionDraft?.requestId !== questionRequestId) {
			this.questionDraft = questionRequestId ? { requestId: questionRequestId, fields: new Map() } : undefined;
		}
		this.toolConfirmation?.setVisible(this.visible && !state.aiDisabled && state.phase !== 'submitting');
		this.elicitationFocused.set(interaction?.request.type === 'userInput' && !state.aiDisabled);
		// Streaming and catalog updates must not replace the approval button under keyboard focus.
		const tool = state.toolInvocation?.call.itemId === interaction?.itemId ? state.toolInvocation : undefined;
		const adjacent = state.toolInvocations?.filter(item => item.call.turnId === tool?.call.turnId) ?? [];
		const toolIdentity = tool ? JSON.stringify([tool.call.turnId, tool.call.itemId, tool.call.name, tool.call.binding]) : undefined;
		if (interaction && interaction === this.renderedInteraction && this.renderedToolIdentity === toolIdentity) {
			if (tool) this.confirmationCarousel?.render(adjacent, tool.call.itemId);
			return;
		}
		this.renderedToolIdentity = toolIdentity;
		this.confirmationCarousel = undefined;
		this.renderedInteraction = interaction;
		this.toolConfirmation = undefined;
		this.interactionListeners.clear();
		this.interaction.replaceChildren();
		if (!interaction) {
			this.interaction.hidden = true;
			return;
		}
		this.interaction.hidden = false;
		const request = interaction.request;
		// Detached forms and buttons must never answer a successor interaction.
		const resolve = (response: Parameters<ChatInputDelegate['resolveInteraction']>[0]): Promise<void> => this.resolveInteraction(interaction, response);
		switch (request.type) {
			case 'toolResultReview': {
				const confirmation = this.interactionListeners.add(this.instantiationService.createInstance(ChatToolPostExecuteConfirmationPart, this.element.ownerDocument, request.request, resolve));
				this.interaction.append(confirmation.domNode);
				break;
			}
			case 'approval': {
				const conversation = state.conversation;
				const explanationContext = conversation ? {
					resource: LocalChatSessionUri.forSession(conversation.sessionId, conversation.threadId),
					isCurrent: () => !this.isDisposed && this.visible && !this.state.aiDisabled && this.state.phase !== 'submitting'
						&& this.renderedInteraction === interaction && this.state.interaction === interaction
						&& this.state.conversation?.sessionId === conversation.sessionId
						&& this.state.conversation?.threadId === conversation.threadId,
				} : undefined;
				const activity = tool?.call.binding?.activity;
				const presentation = activity?.type === 'confirmation' ? activity.presentation : undefined;
				const server = tool?.call.binding?.sourceChain.slice().reverse().find(source => source.type === 'mcp');
				const specialized = presentation?.type === 'modifiedFiles' ? new ChatModifiedFilesConfirmationSubPart(this.element.ownerDocument, resolve, presentation)
					: presentation?.type === 'agentFeedbackReview' ? new ChatAgentFeedbackReviewConfirmationSubPart(this.element.ownerDocument, resolve, presentation)
						: presentation?.type === 'sandboxPrerequisite' ? new ChatSandboxPrerequisiteConfirmationSubPart(this.element.ownerDocument, resolve, presentation)
							: presentation?.type === 'extensionsInstall' ? new ExtensionsInstallConfirmationWidgetSubPart(this.element.ownerDocument, resolve, presentation)
								: presentation?.type === 'authentication' && server?.type === 'mcp' ? this.instantiationService.createInstance(ChatToolAuthenticationSubPart, this.element.ownerDocument, resolve, presentation, server.serverId)
									: undefined;
				const confirmation = this.interactionListeners.add(specialized ?? (request.request.command || request.request.sandboxDenial
					? this.instantiationService.createInstance(ChatTerminalToolConfirmationSubPart, this.element.ownerDocument, resolve, explanationContext)
					: new ToolConfirmationSubPart(this.element.ownerDocument, resolve)));
				confirmation.render(request.request);
				if (confirmation instanceof ChatTerminalToolConfirmationSubPart || confirmation instanceof ChatToolAuthenticationSubPart) {
					this.toolConfirmation = confirmation;
					confirmation.setVisible(this.visible && !state.aiDisabled && state.phase !== 'submitting');
				}
				if (tool && adjacent.length > 1) {
					const carousel = this.confirmationCarousel = this.interactionListeners.add(new ChatToolConfirmationCarouselPart(this.element.ownerDocument, confirmation.domNode));
					carousel.render(adjacent, tool.call.itemId);
					this.interaction.append(carousel.domNode);
				} else this.interaction.append(confirmation.domNode);
				break;
			}
			case 'permissions': {
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
				this.interactionListeners.add(addDisposableListener(decline, 'click', () => void resolve({
					type: 'permissions', response: { duration: 'turn', directories: [], networkHosts: [] },
				}).catch(() => undefined)));
				this.interactionListeners.add(addDisposableListener(form, 'submit', event => {
					event.preventDefault();
					void resolve({
						type: 'permissions', response: {
							duration: duration.value === 'session' ? 'session' : 'turn',
							directories: directories.map(entry => ({ path: entry.path, permissions: entry.permissions.filter(value => value.input.checked).map(value => value.permission) })).filter(entry => entry.permissions.length > 0),
							networkHosts: hosts.filter(value => value.input.checked).map(value => value.host),
						}
					}).catch(() => undefined);
				}));
				break;
			}
			case 'userInput': {
				const form = h(this.element.ownerDocument, 'form');
				form.className = 'ash-chat-interaction-form';
				const inputs = new Map<string, () => string>();
				const fields = this.questionDraft!.fields;
				const validators: (() => void)[] = [];
				for (const question of request.request.questions) {
					const label = h(this.element.ownerDocument, 'label');
					const prompt = question.header && question.header !== question.question
						? localize('chat.interaction.questionPrompt', "{0} — {1}", question.header, question.question)
						: question.question;
					label.textContent = prompt;
					const options = question.options;
					const select = options?.length ? this.questionSelect(options, question.required) : undefined;
					const input = select ?? h(this.element.ownerDocument, 'input');
					const saved = fields.get(question.id);
					input.required = question.required;
					input.name = question.id;
					label.append(input);
					form.append(label);
					inputs.set(question.id, () => input.value);

					if (!select) {
						input.value = saved?.text ?? '';
						const validation = question.validation;
						const validate = () => {
							const invalid = validation && input.value !== '' && !isChatQuestionAnswerValid(input.value, validation);
							input.setCustomValidity(invalid ? localize('chat.interaction.invalidAnswer', "Enter an answer that matches the requested type and limits.") : '');
						};
						validators.push(validate);
						validate();
						this.interactionListeners.add(addDisposableListener(input, 'input', () => {
							fields.set(question.id, { text: input.value });
							validate();
						}));
						continue;
					}
					if (question.allowFreeForm) {
						const customOption = h(this.element.ownerDocument, 'option');
						customOption.value = 'custom';
						customOption.textContent = localize('chat.interaction.customOption', "Enter a custom answer");
						select.append(customOption);

						const customField = h(this.element.ownerDocument, 'div');
						const customLabel = h(this.element.ownerDocument, 'label');
						customLabel.textContent = localize('chat.interaction.customAnswer', "Custom answer for {0}", prompt);
						const customInput = h(this.element.ownerDocument, 'input');
						customInput.value = saved?.text ?? '';
						customLabel.append(customInput);
						customField.append(customLabel);
						form.append(customField);
						const isCustom = () => select.selectedIndex === customOption.index;
						const updateCustomInput = () => {
							const enabled = isCustom();
							customField.hidden = !enabled;
							customInput.disabled = !enabled;
							customInput.required = enabled;
						};
						select.selectedIndex = saved?.choice ?? 0;
						updateCustomInput();
						const save = () => fields.set(question.id, { choice: select.selectedIndex, text: customInput.value });
						this.interactionListeners.add(addDisposableListener(select, 'change', () => {
							updateCustomInput();
							save();
						}));
						this.interactionListeners.add(addDisposableListener(customInput, 'input', save));
						inputs.set(question.id, () => isCustom() ? customInput.value : select.value);
					} else {
						select.selectedIndex = saved?.choice ?? 0;
						this.interactionListeners.add(addDisposableListener(select, 'change', () => fields.set(question.id, { choice: select.selectedIndex, text: '' })));
					}
				}
				const cancel = this.interactionButton(localize('chat.interaction.cancelQuestion', "Cancel question"));
				this.interactionListeners.add(addDisposableListener(cancel, 'click', () => {
					void resolve({ type: 'cancelUserInput' }).catch(() => undefined);
				}));
				form.append(cancel);
				const submit = this.interactionButton(localize('chat.interaction.submit', 'Submit answers'), true);
				submit.type = 'submit';
				form.append(submit);
				this.interaction.append(form);
				this.interactionListeners.add(addDisposableListener(form, 'submit', (event) => {
					event.preventDefault();
					for (const validate of validators) validate();
					if (!form.reportValidity()) return;
					const answers: Record<string, { value: string; }> = {};
					for (const [id, readValue] of inputs) {
						const value = readValue();
						if (value !== '') answers[id] = { value };
					}
					void resolve({
						type: 'userInput',
						response: { answers },
					}).catch(() => undefined);
				}));
				break;
			}
			case 'dynamicTool': {
				const progress = this.interactionListeners.add(new ChatOtherClientToolProgressPart(this.element.ownerDocument, request.call, resolve));
				this.interaction.append(progress.domNode);
				break;
			}
		}
	}

	private interactionButton(label: string, primary = false): HTMLButtonElement {
		const button = h(this.element.ownerDocument, 'button');
		button.type = 'button';
		button.textContent = label;
		button.className = primary ? 'ash-chat-send-button' : 'ash-chat-secondary-button';
		return button;
	}

	private questionSelect(options: readonly { readonly label: string; readonly description: string; }[], required: boolean): HTMLSelectElement {
		const select = h(this.element.ownerDocument, 'select');
		const unanswered = h(this.element.ownerDocument, 'option');
		unanswered.value = '';
		unanswered.disabled = required;
		unanswered.selected = true;
		unanswered.textContent = required
			? localize('chat.interaction.chooseAnswer', "Choose an answer")
			: localize('chat.interaction.unanswered', "No answer");
		select.append(unanswered);
		for (const option of options) {
			const element = h(this.element.ownerDocument, 'option');
			element.value = option.label;
			element.textContent = option.description && option.description !== option.label
				? localize('chat.interaction.optionDescription', "{0} — {1}", option.label, option.description)
				: option.label;
			select.append(element);
		}
		return select;
	}

	protected statusText(state: ChatInputState): string {
		if (state.aiDisabled) return localize('chat.ai.disabled.message', 'AI features are disabled. Turn off Disable AI features in Settings to send messages.');
		if (state.error) return state.error;
		if (state.status !== undefined) return state.status;
		if (state.inputBlocked && state.phase !== 'loading') return '';
		if (this.dictationSession.isStarting) return localize('chat.input.dictationStarting', 'Starting dictation…');
		if (this.dictationSession.isActive && this.speechToText.state === ChatSpeechToTextState.Transcribing) return localize('chat.input.dictationTranscribing', 'Transcribing…');
		if (this.dictationSession.isActive) return localize('chat.input.dictationListening', 'Listening…');
		switch (state.phase) {
			case 'loading':
				return localize('chat.input.loading', 'Loading chat…');
			case 'submitting':
				return localize('chat.input.working', 'Working…');
			case 'error':
				return localize('chat.input.unavailable', 'Chat is unavailable.');
			case 'ready':
				if (state.queuedMessages > 0) return localize('chat.input.queuedMessages', '{0} messages queued', state.queuedMessages);
				if (state.activeMode && state.activeMode !== state.mode) return localize('chat.input.modeChangeQueued', 'Working in {0}. The next message will be queued in {1} mode.', state.activeMode, state.mode);
				return state.canInterrupt ? localize('chat.input.working', 'Working…') : '';
		}
	}
}

class SelectorAction extends ChatInputAction {
	readonly actions: readonly IAction[] | (() => Promise<readonly IAction[]>);

	constructor(id: string, label: string, tooltip: string, icon: Icon | undefined, presentation: 'mode' | 'model', actions: readonly IAction[] | (() => Promise<readonly IAction[]>), enabled = true) {
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

/** One paused queue revision owns its editor; the regular composer and frozen attachments stay intact. */
export class ChatQueueEditor extends Disposable {
	private submitEdit: ((value?: string, options?: IChatAcceptInputOptions) => Promise<void>) | undefined;

	constructor(
		private readonly widget: IChatWidget,
		private readonly requestId: string,
		@IChatService private readonly chat: IChatService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IMenuService private readonly menus: IMenuService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IActionViewItemService private readonly presentations: IActionViewItemService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { super(); }

	acceptInput(value?: string, options?: IChatAcceptInputOptions): Promise<void> {
		if (options?.sideChat) return Promise.reject(new Error(localize('chat.queue.sideChatUnavailable', 'Save or cancel the queued message edit before starting a side chat.')));
		return this.submitEdit?.(value, options) ?? Promise.resolve();
	}

	async show(): Promise<void> {
		const { sessionId, threadId } = this.widget;
		if (!sessionId || !threadId || !this.widget.visible) return;
		let current = () => !this.isDisposed && this.widget.visible && this.widget.sessionId === sessionId && this.widget.threadId === threadId;
		const messages = await this.chat.getPendingRequests(sessionId, threadId);
		if (!current()) return;
		const original = messages.find(message => message.commandId === this.requestId);
		if (!original) throw new Error(localize('chat.queue.conflict', 'This queued message changed or has already started. Choose it again from the queue.'));
		const target = (message: QueuedMessage) => ({ sessionId, threadId, commandId: message.commandId, expectedRevision: message.revision });
		const paused = await this.chat.pausePendingRequest(target(original));
		const resume = () => original.status === 'pending' ? this.chat.resumePendingRequest(target(paused)).then(() => undefined) : Promise.resolve();
		if (!current()) { await resume(); return; }
		using lifetime = new DisposableStore();
		const content = h(this.widget.domNode.ownerDocument, 'div');
		const context = lifetime.add(this.contextKeys.createScoped(content));
		const scope = lifetime.add(this.instantiation.createChild(new ServiceCollection([IContextKeyService, context])));
		const type = paused.steerTurnId ? ChatContextKeys.EditingRequestType.Steer : ChatContextKeys.EditingRequestType.Queue;
		ChatContextKeys.editingRequestType.bindTo(context).set(type);
		const hasText = ChatContextKeys.inputHasText.bindTo(context);
		const blocked = ChatContextKeys.inputBlocked.bindTo(context);
		ChatContextKeys.transcriptProgressActive.bindTo(context).set(false);
		const defaultAction = context.createKey(`config.${ChatConfiguration.RequestQueueingDefaultAction}`, this.configuration.getValue<string>(ChatConfiguration.RequestQueueingDefaultAction) ?? 'steer');
		lifetime.add(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.RequestQueueingDefaultAction)) defaultAction.set(this.configuration.getValue<string>(ChatConfiguration.RequestQueueingDefaultAction) ?? 'steer');
		}));
		const input = lifetime.add(new InputBox(content, { flexibleHeight: true, flexibleMaxHeight: 240, ariaLabel: localize('chat.queue.editTitle', 'Edit queued message'), inputBoxStyles: defaultInputBoxStyles }));
		input.value = paused.text;
		ChatContextKeys.inChatInput.bindTo(lifetime.add(context.createScoped(input.inputElement))).set(true);
		const hint = h(content.ownerDocument, 'p');
		hint.textContent = localize('chat.queue.editHint', 'The message is paused while editing. Enter keeps its queue or steering action; Alt+Enter uses the other action. Ctrl or Command+Enter saves. Escape cancels. Attached inputs and the unsent draft are kept. Previously paused or failed messages stay paused when cancelled.');
		hint.id = createUuid();
		input.inputElement.setAttribute('aria-describedby', hint.id);
		const feedback = h(content.ownerDocument, 'p');
		feedback.setAttribute('role', 'alert');
		content.append(hint, feedback);
		const toolbar = lifetime.add(new WorkbenchToolBar(content, this.contextMenus, {
			actionViewItemProvider: (action, options) => action instanceof SubmenuItemAction
				? this.presentations.lookUp(MenuId.ChatExecute, action.item.submenu)?.(action, { ...options, actionContext: { widget: this.widget } }, scope, 0)
				: undefined,
		}));
		const menu = lifetime.add(this.menus.createMenu(MenuId.ChatExecute, context));
		const renderActions = () => toolbar.setActions(menu.getActions({ arg: { widget: this.widget } }).flatMap(([, actions]) => actions));
		lifetime.add(menu.onDidChange(renderActions));
		const save = lifetime.add(new Button(content, { label: localize('chat.queue.save', 'Save queued message'), presentation: 'primary' }));
		const dialog = this._register(new Dialog(this.widget.domNode, localize('chat.queue.editTitle', 'Edit queued message'), undefined, {
			disableDefaultAction: true, buttonStyles: defaultButtonStyles, checkboxStyles: defaultCheckboxStyles, dialogStyles: defaultDialogStyles, inputBoxStyles: defaultInputBoxStyles,
			renderBody: container => container.append(content),
		}));
		let saved = false;
		let hidden = false;
		let pending: Promise<void> | undefined;
		const update = (): void => {
			hasText.set(!!input.value.trim()); blocked.set(!!pending);
			save.enabled = !!input.value.trim() && !pending;
		};
		this.submitEdit = (value, options) => {
			if (value !== undefined && !pending) input.value = value;
			if (pending || !current() || !input.value.trim()) return pending ?? Promise.resolve();
			input.inputElement.readOnly = true;
			feedback.textContent = '';
			pending = (options?.cancelCurrentRequest
				? this.chat.sendPendingRequestImmediately(target(paused), input.value)
				: this.chat.editPendingRequest(target(paused), input.value, options?.queue ?? (paused.steerTurnId ? ChatRequestQueueKind.Steering : ChatRequestQueueKind.Queued)))
				.then(() => { saved = true; announceStatus(localize('chat.queue.saved', 'Queued message saved.')); dialog.dispose(); }, error => {
					if (!hidden) feedback.textContent = localize('chat.queue.saveFailed', 'Could not save queued message: {0}', String(error instanceof Error ? error.message : error));
				}).finally(() => { pending = undefined; input.inputElement.readOnly = false; update(); });
			update();
			return pending;
		};
		lifetime.add(save.onDidClick(() => { void this.acceptInput(); }));
		lifetime.add(addDisposableListener(input.inputElement, 'input', update));
		lifetime.add(addDisposableListener(input.inputElement, 'keydown', event => {
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { stopEvent(event); void this.acceptInput(); }
		}));
		const retire = () => { current = () => false; dialog.dispose(); };
		lifetime.add(this.widget.onDidHide(retire));
		lifetime.add(this.widget.onDidChangeViewModel(retire));
		update(); renderActions();
		try { await dialog.show(); hidden = true; await pending; }
		finally {
			this.submitEdit = undefined;
			if (!saved) await resume();
			if (current()) this.widget.focusInput();
		}
	}
}
