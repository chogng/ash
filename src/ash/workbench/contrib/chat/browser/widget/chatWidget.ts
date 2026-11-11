import type { MemoryNamespace } from '../../../../../platform/memories/common/memoriesService.js';
import type { ChatResponseActions } from './chatListRenderer.js';
import { ChatGoalBannerWidget } from './input/chatGoalBannerWidget.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { parseInlineFileReference } from '../../common/widget/annotations.js';
import { getEditorOverrideForChatResource } from './chatEditorAssociations.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import type { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { readWorkspaceChanges } from './input/chatInput.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ChatSubmissionOptions, ChatRequestQueueKind, QueuedMessage } from '../../../../services/chat/common/chatService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { applyAgentHostCompletionAction } from '../agentHostCompletionAction.js';
import { OPEN_SESSION_LINK_SCHEME } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { localize } from '../../../../../nls.js';
import './media/chat.css';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { Emitter, type Event } from '../../../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKeyService, type IScopedContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import type { AgentInteractionDecision, ApprovalMode, ChatAgent, ChatMode, ModelRef, SessionId, ThreadGoal, ThreadId } from '../../../../services/chat/common/chatService.js';
import type { ChatInputDelegate } from './input/chatInput.js';
import type { SkillReference } from '../../../../../platform/agentHost/common/appServerApi.js';
import { ChatInputPart, type IChatInputPart, type IChatDraftStorage } from './input/chatInputPart.js';
import type { ChatStreamingResponseUpdate, ChatTurnErrorAction } from '../../common/model/chatViewModel.js';
import { ChatListWidget } from './chatListWidget.js';
import type { ChatInputState } from './input/chatInput.js';
import { chatResponseFollowups } from '../../common/model/chatFollowup.js';
import type { ModelReasoningEffort } from '../../../../services/chat/common/modelCatalog.js';
import type { IChatListItem } from '../../common/model/chatViewModel.js';
import { resolveChatContextAttachment, type ResolvedChatContext } from '../../../../services/chat/common/chatContextService.js';
import { addDisposableListener, getActiveWindow, h } from '../../../../../base/browser/dom.js';
import { RestoreAgentSessionActionId } from '../agentSessions/agentSessionsActions.js';
import { ChatReadOnlyBanner } from './chatReadOnlyBanner.js';
import { ChatWindowBlurListener } from './chatWindowBlurListener.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { AgentsVoiceWidget } from '../../../agentsVoice/browser/agentsVoiceWidget.js';
import { IVoiceModeOnboardingService } from '../../../agentsVoice/browser/voiceModeOnboarding.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import type { IChatSessionHistoryStatus } from '../../../../../platform/chat/common/chatSessionHistory.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import type { ChatContextAttachment, ChatImageCapture } from '../../../../services/chat/common/chatContextService.js';
import { extractSelection, type IOpenerService } from '../../../../../platform/opener/common/opener.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ASH_REMOTE_SCHEME, createSshRemoteWorkspaceUri, getRemoteWorkspacePath } from '../../../../../platform/remote/common/remote.js';
import { OPEN_CHAT_CHANGES_COMMAND_ID, OPEN_CHAT_SETTINGS_COMMAND_ID, OPEN_CHAT_PERMISSIONS_COMMAND_ID, OPEN_GUARDIAN_SETUP_COMMAND_ID } from '../../common/chat.js';
import { OpenSettingsCommandId } from '../../../preferences/common/preferences.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatQueueEditor } from './input/chatInputPart.js';
import { ChatInputEditors } from './input/chatInputEditorRegistry.js';
import { ChatRequestOriginPart } from './chatContentParts/chatRequestOriginPart.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';
import type { IChatMcpAppDelegate } from './chatContentParts/toolInvocationParts/chatMcpAppModel.js';
import { VoiceSessionController, pickVoiceConversation } from '../voiceClient/voiceSessionController.js';
import type { AgentVoiceTaskRequest } from '../../../../../platform/agentHost/common/agent.js';
import { IChatWidgetService, type IChatWidget, type IChatFindController, type IChatAcceptInputOptions, type IChatWidgetViewOptions, type IChatWidgetViewState } from '../chat.js';
import { ChatViewWelcomePart } from '../viewsWelcome/chatViewWelcomeController.js';

/** The presentation consumes one conversation model owned by its product. */
export interface IChatWidgetModel extends IDisposable {
	readonly memoryNamespace?: MemoryNamespace;
	readonly thread?: import('../../../../services/chat/common/chatService.js').Thread;
	readonly onDidChange: Event<void>;
	/** The same notification can identify an isolated text append for the transcript. */
	readonly onDidChangePresentation?: Event<ChatStreamingResponseUpdate | void>;
	readonly onDidChangeComposer: Event<void>;
	readonly composerGeneration: number;
	readonly sessionId: SessionId | undefined;
	readonly threadId: ThreadId | undefined;
	readonly untitledSessionId: string | undefined;
	readonly goal: ThreadGoal | undefined;
	readonly items: readonly IChatListItem[];
	readonly inputState: ChatInputState;
	readonly draft?: ChatInputDelegate['draft'];
	readonly voice?: {
		readonly isAvailable: boolean;
		readonly isActive: boolean;
		readonly isConnecting: boolean;
		readonly isConnected: boolean;
		start(window: Window & typeof globalThis): Promise<void>;
		stop(): Promise<void>;
	};
	readResponseResource?(item: IChatListItem, resource: URI, signal: AbortSignal): Promise<Blob>;
	getResponseActions?(item: IChatListItem): ChatResponseActions | undefined;
	submitRequestEdit?(item: IChatListItem, text: string, commandId: string): Promise<void>;
	getRequestVersions?(item: IChatListItem): Promise<readonly import('../chat.js').ChatRequestVersion[]>;
	readonly historyStatus?: IChatSessionHistoryStatus;
	readonly canRestoreArchivedSession?: boolean;
	readonly olderHistory?: { readonly loading: boolean; readonly error?: string; };
	loadOlderHistory?(): Promise<void>;
	prepareConversation?(signal?: AbortSignal): Promise<{ readonly sessionId: string; readonly threadId: string; }>;
	send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], submissionOptions?: ChatSubmissionOptions): Promise<void>;
	executeServerCommand?(name: string, argumentsText: string, submissionSignal?: AbortSignal): Promise<void | string>;
	reportRecapPresence?(sessionId: SessionId, threadId: ThreadId, surface: string, focused: boolean | null): Promise<void>;
	/** Rejects on failure so Stop and Send can preserve the unsent draft. */
	interrupt(): Promise<void>;
	refreshChanges?(): Promise<void>;
	selectModel(model: ModelRef): Promise<void>;
	selectPreset?(presetId: string): Promise<void>;
	selectReasoningEffort?(effort: ModelReasoningEffort | undefined): Promise<void>;
	selectAutomaticModel?(): Promise<void>;
	listAgents?(): Promise<readonly ChatAgent[]>;
	selectAgent?(agent: ChatAgent | undefined): void;
	selectMode?(mode: ChatMode): void;
	selectApprovalMode?(mode: ApprovalMode): void;
	resolveInteraction?(response: AgentInteractionDecision, expectedRequestId?: string): Promise<void>;
	retryFailedTurn?(turnId: string): Promise<void>;
}

/** Owns the content and interaction state for one local or durable Chat tab. */
export class ChatWidget<TModel extends IChatWidgetModel = IChatWidgetModel> extends Disposable implements IChatWidget {
	readonly element: HTMLElement;
	protected readonly scopedContextKeys: IScopedContextKeyService;
	private readonly hidden = this._register(new Emitter<void>());
	readonly onDidHide = this.hidden.event;
	private readonly visibilityChanged = this._register(new Emitter<void>());
	readonly onDidChangeVisibility = this.visibilityChanged.event;
	private readonly voiceSessionController: VoiceSessionController | undefined;
	private readonly voiceWidget: AgentsVoiceWidget | undefined;
	readonly model: TModel;
	private listWidget: ChatListWidget;
	private readonly queueEditor = this._register(new MutableDisposable<ChatQueueEditor>());
	public readonly input: IChatInputPart;
	private readonly goalBanner: ChatGoalBannerWidget;
	private readonly readOnlyBanner: ChatReadOnlyBanner;
	private readonly olderHistoryElement: HTMLDivElement;
	private readonly olderHistoryButton: Button;
	private readonly olderHistoryMessage: HTMLSpanElement;
	private readonly historyStatusElement: HTMLDivElement;
	private readonly historyMessage: HTMLSpanElement;
	private readonly historyAction: Button;
	private historyRecovery: { readonly status: IChatSessionHistoryStatus; readonly generation: number; } | undefined;
	private submittedMessage = false;
	private readonly welcome: ChatViewWelcomePart;
	private readonly recapSurface = generateUuid();
	private readonly recapFocusListeners = this._register(new DisposableStore());
	private readonly recapBlurListener: ChatWindowBlurListener | undefined;
	private recapDocument: Document | undefined;
	private recapView: { sessionId: SessionId; threadId: ThreadId; focused: boolean; } | undefined;
	private recapPresencePending = Promise.resolve();
	private displayedConversationId: string | undefined;

	constructor(
		container: HTMLElement,
		panelId: string,
		model: TModel,
		private readonly createUntitledSession: () => void,
		contextMenuService: IContextMenuService,
		contextViewService: IContextViewService,
		commandService: ICommandService,
		accessibleViewService: IAccessibleViewService,
		private readonly notifications: INotificationService,
		openerService: IOpenerService | undefined,
		editorService: IEditorService | undefined,
		imageResourceLoader: ((resource: URI) => Promise<Blob>) | undefined,
		createInputPart: ((container: HTMLElement, delegate: ChatInputDelegate) => IChatInputPart) | undefined,
		private readonly viewOptions: IChatWidgetViewOptions | undefined,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDialogService dialogs: IDialogService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IChatWidgetService widgets: IChatWidgetService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IVoiceModeOnboardingService private readonly voiceOnboarding: IVoiceModeOnboardingService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		this.model = this._register(model);
		const modelVoice = model.voice;
		const voiceClient = this.voiceSessionController = modelVoice ? undefined : this._register(instantiationService.createInstance(VoiceSessionController, async (request: AgentVoiceTaskRequest, signal: AbortSignal) => {
			if (signal.aborted || this.isDisposed || this.model.sessionId !== request.sessionId || this.model.threadId !== request.threadId) throw canceled();
			// The original composer/model owns mode, queue, steering and approval. Speech remains low-trust context.
			await this.model.send(localize('chat.voice.task.submit', 'Handle the request I just spoke.'), this.model.inputState.mode, undefined, [{ name: localize('chat.voice.task.context', 'Voice request'), content: request.transcript }], { commandId: request.commandId, source: { sessionId: request.sessionId, threadId: request.threadId }, signal });
		}, (error: unknown) => this.reportVoiceError(error), this.model.prepareConversation ? async (signal: AbortSignal) => {
			const source = await this.model.prepareConversation!(signal);
			if (this.isDisposed || source.sessionId !== this.model.sessionId || source.threadId !== this.model.threadId) throw canceled();
			return source;
		} : undefined));
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.id = panelId;
		this.element.className = viewOptions?.classPrefix ?? 'ash-chat';
		this.element.setAttribute('role', 'tabpanel');
		this.element.hidden = true;
		container.append(this.element);
		const context = this.scopedContextKeys = this._register(contextKeys.createScoped(this.element));
		ChatContextKeys.inChatSession.bindTo(context).set(true);
		const activeRequest = ChatContextKeys.hasActiveRequest.bindTo(context);
		activeRequest.set(model.inputState.canInterrupt);
		this._register(model.onDidChange(() => activeRequest.set(model.inputState.canInterrupt)));
		const transcriptProgress = ChatContextKeys.transcriptProgressActive.bindTo(context);
		transcriptProgress.set(this.isTranscriptProgressActive);
		this._register(model.onDidChange(() => transcriptProgress.set(this.isTranscriptProgressActive)));
		ChatContextKeys.findSupported.bindTo(context).set(true);
		const findVisible = ChatContextKeys.findWidgetVisible.bindTo(context);
		// Detached Markdown fragments still inherit this conversation's command scope.
		const scopedInstantiation = this._register(instantiationService.createChild(new ServiceCollection([IContextKeyService, context])));
		const inQuickChat = ChatContextKeys.inQuickChat.bindTo(context);
		if (model.reportRecapPresence) {
			this.recapBlurListener = this._register(new ChatWindowBlurListener(this.element, () => this.syncRecapPresence()));
			this._register(toDisposable(() => this.syncRecapPresence(false)));
		}
		this._register(addDisposableListener(this.element, 'focusin', () => {
			// Quick Chat borrows this widget by reparenting it; its original scope stays alive.
			inQuickChat.set(contextKeys.getContext(this.element.parentElement).getValue<boolean>(ChatContextKeys.inQuickChat.key) === true);
		}));
		this.goalBanner = new ChatGoalBannerWidget(ownerDocument);
		this.readOnlyBanner = this._register(new ChatReadOnlyBanner(ownerDocument, async sessionId => {
			try {
				await commandService.executeCommand(RestoreAgentSessionActionId, sessionId);
			} catch (error) {
				if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(String(error));
			}
		}));
		this.olderHistoryElement = h(ownerDocument, 'div');
		this.olderHistoryElement.className = 'ash-chat-history-pagination';
		this.olderHistoryElement.hidden = true;
		this.olderHistoryButton = this._register(new Button(this.olderHistoryElement, {
			...defaultButtonStyles,
			label: localize('chat.history.loadOlder', 'Load earlier messages'),
			size: 'small',
			presentation: 'quiet',
		}));
		this.olderHistoryMessage = h(ownerDocument, 'span');
		this.olderHistoryMessage.setAttribute('role', 'status');
		this.olderHistoryElement.append(this.olderHistoryMessage);
		this._register(this.olderHistoryButton.onDidClick(() => void this.loadOlderHistory()));
		this.historyStatusElement = h(ownerDocument, 'div');
		this.historyStatusElement.className = 'ash-chat-history-status';
		this.historyStatusElement.hidden = true;
		this.historyMessage = h(ownerDocument, 'span');
		this.historyMessage.setAttribute('role', 'status');
		this.historyStatusElement.append(this.historyMessage);
		this.historyAction = this._register(new Button(this.historyStatusElement, {
			...defaultButtonStyles,
			label: '',
			size: 'small',
		}));
		this._register(this.historyAction.onDidClick(() => void this.recoverHistory()));
		const historyAccessibilityId = createUuid();
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 100, name: `chatHistory-${type}-${historyAccessibilityId}`,
				getProvider: () => {
					const focused = ownerDocument.activeElement as HTMLElement | null;
					const pagination = !!focused && this.olderHistoryElement.contains(focused);
					if (!focused || !pagination && !this.historyStatusElement.contains(focused)) return undefined;
					const provider = new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type }, () => pagination
						? type === AccessibleViewType.Help
							? localize('chat.history.paginationHelp', 'Chat initially shows recent messages. Use Tab to reach Load earlier messages, then Enter or Space to load another page. Loading preserves your draft, active approvals and reading position. If it fails, use Retry earlier messages. Live messages remain available while older history loads.')
							: [this.olderHistoryButton.label, this.olderHistoryMessage.textContent].filter(Boolean).join('\n')
						: type === AccessibleViewType.Help
							? localize('chat.history.recoveryHelp', 'When chat history or updates cannot load, use Tab to reach Retry loading chat and Enter or Space to retry. Recovery preserves your draft and attachments and never sends a message. Sending stays unavailable until loading succeeds. Closing accessibility help returns focus to recovery, or to the message input when recovery is complete.')
							: [this.model.historyStatus?.message, this.model.historyStatus?.action.label].filter(Boolean).join('\n'),
						() => { if (!this.isDisposed) { if ((pagination ? this.olderHistoryElement : this.historyStatusElement).hidden) this.focus(); else focused.focus(); } }, AccessibilityVerbositySettingId.Chat);
					provider.onDidChangeContent = this.model.onDidChange;
					return provider;
				},
			}));
		}
		const openChangesForTurn = this.viewOptions?.openTurnChanges;
		const openTurnChanges: IChatWidgetViewOptions['openTurnChanges'] = openChangesForTurn && (async (source, signal) => {
			if (!this.visible || model.sessionId !== source.sessionId || model.threadId !== source.threadId) return;
			using listeners = new DisposableStore();
			const controller = new AbortController();
			listeners.add(this.onDidHide(() => controller.abort()));
			listeners.add(model.onDidChangeComposer(() => controller.abort()));
			await openChangesForTurn(source, AbortSignal.any([signal, controller.signal]));
		});
		const listWidgets = ChatListWidget.instantiateObservable(scopedInstantiation, this._store, h(ownerDocument, 'div'), {
			classPrefix: viewOptions?.classPrefix,
			onDidRequestEdit: (requestId: string) => this.startEditing(requestId),
			canEditRequest: () => !this.isTranscriptProgressActive,
			submitRequestEdit: model.submitRequestEdit?.bind(model),
			getRequestVersions: model.getRequestVersions?.bind(model),
			promptTimelineChanges: this.viewOptions?.promptTimelineChanges,
			getTurnChanges: this.viewOptions?.getTurnChanges,
			messagePresentation: this.viewOptions?.messagePresentation,
			codeBlockPresentation: this.viewOptions?.codeBlockPresentation,
			showPromptTimeline: this.viewOptions?.showPromptTimeline,
			virtualizeHistoryFrom: this.viewOptions?.virtualizeHistoryFrom,
			readResponseResource: model.readResponseResource?.bind(model),
			inspectResponseEntity: this.viewOptions?.inspectResponseEntity,
			getResponseActions: model.getResponseActions?.bind(model),
			openTurnChanges,
			onDidChangeFindVisibility: (visible: boolean) => findVisible.set(visible),
			getHistoryState: () => this.model.olderHistory,
			loadOlderHistory: async () => { await this.model.loadOlderHistory?.(); },
			imageResourceLoader,
			mcpAppDelegate: {
				updateModelContext: (source, text, images = []) => {
					const id = this.appContextId(source);
					const model = this.input.attachmentModel;
					const owned = (attachment: ChatContextAttachment) => attachment.id === id || attachment.id.startsWith(`${id}:image:`);
					const lifetime = new DisposableStore();
					const name = localize('chat.mcpApp.contextLabel', 'App context');
					const attachments: ChatContextAttachment[] = [
						...(text ? [{ id, kind: 'mcpApp', lifetime: 'source' as const, name, resolve: async () => ({ name, content: text }) }] : []),
						...images.map((image, index) => ({ ...image, id: `${id}:image:${index}`, lifetime: 'source' as const })),
					];
					model.updateContext(model.attachments.filter(owned).map(attachment => attachment.id), attachments);
					lifetime.add(toDisposable(() => {
						// An older App lease cannot revoke a capture published by its replacement.
						model.delete(...attachments.filter(attachment => model.attachments.includes(attachment)).map(attachment => attachment.id));
					}));
					return lifetime;
				},
				sendMessage: async (source, text, signal, images = []) => {
					const id = this.appContextId(source);
					// An App follow-up includes its own source context, never a user's unsent draft or files.
					const contexts = [...this.input.attachmentModel.attachments.filter(attachment => attachment.id === id || attachment.id.startsWith(`${id}:image:`)), ...images];
					await this.send(text, this.model.inputState.mode, undefined, contexts, source, signal);
				},
			} satisfies IChatMcpAppDelegate,
			onDidRequestLink: (target: string) => {
				void openChatMarkdownLink(target, openerService, editorService, configuration).catch(error => console.error('Could not open Markdown link', error));
			},
			get memoryNamespace() { return model.memoryNamespace; },
			onDidRequestMemoryReference: (reference: string) => { void commandService.executeCommand('ash.memories.openReference', reference).catch(error => console.error('Could not open memory reference', error)); },
			onDidRequestErrorAction: (action: ChatTurnErrorAction) => this.handleTurnErrorAction(action),
		});
		this.listWidget = listWidgets.get();
		const inputDelegate: ChatInputDelegate = {
			responseProgressInTranscript: true,
			draft: model.draft,
			voiceConversation: modelVoice ? {
				get isAvailable() { return modelVoice.isAvailable && !model.inputState.aiDisabled; },
				get isActive() { return modelVoice.isActive; },
				get isConnecting() { return modelVoice.isConnecting; },
				get isConnected() { return modelVoice.isConnected; },
				toggle: () => this.runVoice(() => modelVoice.isActive ? modelVoice.stop() : modelVoice.start(ownerDocument.defaultView!)),
				interrupt: () => this.runVoice(() => modelVoice.stop()),
			} : voiceClient && {
				get isAvailable() { return voiceClient.isAvailable && !model.inputState.aiDisabled; },
				get isActive() { return voiceClient.isActive; },
				get isConnecting() { return voiceClient.isConnecting; },
				get isConnected() { return voiceClient.isConnected; },
				get connectedPlaceholder() {
					if (!voiceClient.isConnected) return undefined;
					if (voiceClient.isMuted) return localize('agentsVoice.mutedStatus', 'Microphone muted');
					if (voiceClient.inputMode === 'pushToTalk' && !voiceClient.isListening) return localize('agentsVoice.readyPtt', 'Press and hold to speak');
					return undefined;
				},
				toggle: () => this.runVoice(() => {
					if (voiceClient.isActive) return voiceClient.disconnect();
					return this.startVoiceConversation();
				}),
				interrupt: () => this.runVoice(() => voiceClient.stopSpeaking()),
			},
			send: (text, mode, skills, contexts, submissionSignal, queue) => this.send(text, mode, skills, contexts, undefined, submissionSignal, queue),
			executeCommand: (invocation) => invocation.commandId === OPEN_CHAT_PERMISSIONS_COMMAND_ID || invocation.commandId === OPEN_GUARDIAN_SETUP_COMMAND_ID
				? commandService.executeCommand(invocation.commandId, this.model, invocation.argumentsText)
				: invocation.argumentsText ? commandService.executeCommand(invocation.commandId, invocation.argumentsText) : commandService.executeCommand(invocation.commandId),
			executeServerCommand: model.executeServerCommand && (async (invocation, submissionSignal) => {
				if (invocation.name === 'advisor' && !invocation.argumentsText.trim()) {
					await commandService.executeCommand(OPEN_CHAT_SETTINGS_COMMAND_ID);
					return;
				}
				const recap = await model.executeServerCommand!(invocation.name, invocation.argumentsText, submissionSignal);
				if (typeof recap === 'string') {
					this.notifications.info(recap);
				}
			}),
			interrupt: () => this.model.interrupt(),
			openChanges: model.refreshChanges && (async (revision, file) => {
				try { await commandService.executeCommand(OPEN_CHAT_CHANGES_COMMAND_ID, this.model.sessionId, this.model.threadId, revision, file); }
				finally { void model.refreshChanges!(); }
			}),
			readWorkspaceChanges: model.refreshChanges && (() => readWorkspaceChanges(commandService)),
			selectModel: (model) => this.model.selectModel(model),
			selectPreset: presetId => model.selectPreset?.(presetId) ?? Promise.resolve(),
			selectReasoningEffort: effort => model.selectReasoningEffort?.(effort) ?? Promise.resolve(),
			selectAutomaticModel: model.selectAutomaticModel?.bind(model),
			listAgents: () => model.listAgents?.() ?? Promise.resolve([]),
			selectAgent: agent => model.selectAgent?.(agent),
			selectMode: mode => model.selectMode?.(mode),
			selectApprovalMode: model.selectApprovalMode && (async mode => {
				const generation = this.model.composerGeneration;
				const identity = this.model.threadId ?? this.model.untitledSessionId;
				await applyAgentHostCompletionAction(mode, confirmation => dialogs.confirm(confirmation),
					() => !this.isDisposed && generation === this.model.composerGeneration
						&& identity === (this.model.threadId ?? this.model.untitledSessionId) && !this.model.inputState.aiDisabled,
					selected => model.selectApprovalMode!(selected));
			}),
			openModelSettings: (category = 'models') => commandService.executeCommand(OpenSettingsCommandId, { section: category }),
			resolveInteraction: (response, expectedRequestId) => model.resolveInteraction?.(response, expectedRequestId) ?? Promise.resolve(),
		};
		this.input = this._register(createInputPart
			? createInputPart(this.element, inputDelegate)
			: instantiationService.createInstance(ChatInputPart, this.element, inputDelegate, contextMenuService, contextViewService, accessibleViewService, notifications, ChatInputEditors, [], { modePicker: 'visible', modelPickerPosition: 'leading', configureModelInMenu: viewOptions?.configureModelInMenu, get workspacePickerDelegate() { return viewOptions?.workspacePickerDelegate; } }));
		this.listWidget.setScrollToLatestHost(this.input.changesActionsHost, this.input.composerForm, this.input.changesSummaryVisible);
		this._register(widgets.register(this));
		if (model.prepareConversation || model.sessionId) this._register(scopedInstantiation.createInstance(ChatRequestOriginPart, this.element, model));
		const voiceContainer = h(ownerDocument, 'div');
		let hold: string | undefined;
		const inlineVoice = this.input instanceof ChatInputPart && this.input.usesInlineVoiceControls;
		this.voiceWidget = voiceClient && !inlineVoice ? this._register(instantiationService.createInstance(AgentsVoiceWidget, voiceContainer, {
			openSession: () => this.input.focus(),
			toggleMute: () => { void this.runVoice(() => voiceClient.setMuted(!voiceClient.isMuted)); },
			toggleInputMode: () => { void this.runVoice(() => voiceClient.setInputMode(voiceClient.inputMode === 'pushToTalk' ? 'openMic' : 'pushToTalk')); },
			pttDown: () => { hold = generateUuid(); const id = hold; void this.runVoice(() => voiceClient.pttDown(id)); },
			pttUp: () => { const id = hold; hold = undefined; if (id) void this.runVoice(() => voiceClient.pttUp(id)); },
			disconnect: () => { void this.runVoice(() => voiceClient.disconnect()); },
			stopPlayback: () => { void this.runVoice(() => voiceClient.stopSpeaking()); },
			closeWindow: () => this.input.focus(),
			showSessionsPicker: () => this.input.focus(),
		}, { showClose: false, showOnboarding: false, inputBoxLayout: true })) : undefined;
		this.welcome = new ChatViewWelcomePart(ownerDocument);
		if (viewOptions?.welcomeTitle) this._register(autorun(reader => {
			viewOptions.welcomeTitle!.read(reader);
			this.updateConversationState();
		}));
		this.element.append(this.goalBanner.domNode, this.olderHistoryElement, this.welcome.element, this.listWidget.element, this.historyStatusElement, voiceContainer, this.readOnlyBanner.domNode, this.input.element);
		this._register(listWidgets.onDidChange(widget => {
			const previous = this.listWidget;
			const state = previous.getViewState();
			previous.element.replaceWith(widget.element);
			this.listWidget = widget;
			widget.setScrollToLatestHost(this.input.changesActionsHost, this.input.composerForm, this.input.changesSummaryVisible);
			widget.restoreViewState(state, this.model.items, this.responseWorking);
		}));
		this._register(this.model.onDidChangeComposer(() => { this.input.invalidatePendingInput(); this.listWidget.resetFind(); }));
		this._register((this.model.onDidChangePresentation ?? this.model.onDidChange)(update => {
			if (this.model.inputState.aiDisabled && voiceClient?.isActive) void this.runVoice(() => voiceClient.disconnect());
			if (!update || !this.listWidget.tryQueueStreamingResponse(update)) this.render();
		}));
		if (voiceClient) this._register(voiceClient.onDidChange(() => { if (!this.isDisposed) this.render(); }));
		this._register(toDisposable(() => this.element.remove()));
		this.render();
	}

	get sessionId(): SessionId | undefined {
		return this.model.sessionId;
	}

	get untitledSessionId(): string | undefined {
		return this.model.untitledSessionId;
	}

	get threadId(): ThreadId | undefined {
		return this.model.threadId;
	}

	get domNode(): HTMLElement { return this.element; }
	public cancelTranscriptProgress(): boolean {
		if (this.isDisposed || !this.visible || !this.model.inputState.canInterrupt) { return false; }
		const generation = this.model.composerGeneration;
		void this.model.interrupt().catch(error => { if (!this.isDisposed && this.visible && generation === this.model.composerGeneration && !isCancellationError(error)) { this.notifications.error(error); } });
		return true;
	}
	public getFindController(): IChatFindController { return this.listWidget.getFindController(); }
	public focusResponseItem(lastFocused?: boolean): void { this.listWidget.focusResponseItem(lastFocused); }
	public focusCodeBlock(reverse = false): void { this.listWidget.focusCodeBlock(reverse); }
	public focusInput(): void {
		if (this.readOnlyBanner.visible) this.readOnlyBanner.focus();
		else this.input.focus();
	}
	public getFocus(): IChatListItem | undefined { return this.listWidget.getFocus(); }
	public getFileTreeInfosForResponse(item: IChatListItem) { return this.listWidget.getFileTreeInfosForResponse(item); }
	public getLastFocusedFileTreeForResponse(item: IChatListItem) { return this.listWidget.getLastFocusedFileTreeForResponse(item); }
	public getSibling(item: IChatListItem | undefined, type: 'next' | 'previous'): IChatListItem | undefined { return this.listWidget.getSibling(item, type); }
	public reveal(item: IChatListItem): void { this.listWidget.reveal(item); }
	get visible(): boolean { return !this.element.hidden; }
	get inputEditor() { return this.input.inputEditor; }
	get isTranscriptProgressActive(): boolean { return this.model.inputState.inputBlocked === true || this.model.inputState.aiDisabled === true; }
	get onDidChangeViewModel(): Event<void> { return this.model.onDidChangeComposer; }

	setTabId(tabId: string | undefined): void {
		if (tabId) {
			this.element.setAttribute('aria-labelledby', tabId);
			this.element.removeAttribute('aria-label');
		} else {
			this.element.removeAttribute('aria-labelledby');
			this.element.setAttribute('aria-label', 'Chat');
		}
	}

	setVisible(visible: boolean): void {
		const wasVisible = this.visible;
		// Capture the transcript's reading position while its viewport can still be measured.
		if (!visible) this.listWidget.setVisible(false);
		this.element.hidden = !visible;
		if (wasVisible !== visible) { this.visibilityChanged.fire(); }
		if (wasVisible && !visible) this.hidden.fire();
		if (!visible && this.model.voice?.isActive) void this.runVoice(() => this.model.voice!.stop());
		const voiceClient = this.voiceSessionController;
		if (!visible && voiceClient?.isActive) void this.runVoice(() => voiceClient.disconnect());
		this.syncRecapPresence(visible);
		this.input.setVisible(visible && !this.readOnlyBanner.visible);
		if (visible) this.listWidget.setVisible(true);
	}

	public getViewState(): IChatWidgetViewState {
		const { visible, focus, ...state } = this.listWidget.getViewState();
		return state;
	}

	public restoreViewState(state: IChatWidgetViewState): void {
		this.listWidget.restoreViewState({ ...state, visible: this.visible, focus: undefined }, this.model.items, this.responseWorking);
	}

	public focus(item?: IChatListItem): void {
		if (item) { this.listWidget.focus(item); }
		else { this.focusInput(); }
	}
	/** A floating control starts through this Chat's original source and task dispatcher. */
	startVoiceConversation(): Promise<void> {
		if (this.model.inputState.aiDisabled) return Promise.reject(new Error(localize('chat.ai.disabled.message', 'AI features are disabled. Turn off Disable AI features in Settings to send messages.')));
		if (this.model.voice) return this.model.voice.start(this.element.ownerDocument.defaultView!);
		this.voiceOnboarding.showIfNeeded();
		return this.voiceSessionController!.connect(getActiveWindow(), (connections, signal) => pickVoiceConversation(this.quickInput, connections, signal));
	}

	acquireContext(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>, signal?: AbortSignal): Promise<readonly ChatContextAttachment[]> {
		return this.input.acquireContext(prepare, signal);
	}

	addContext(attachment: ChatContextAttachment): void {
		this.input.addContext(attachment);
	}

	captureScreenshot(capture?: ChatImageCapture): Promise<void> {
		return this.input.captureScreenshot(capture);
	}

	bindDraftStorage(storage: IChatDraftStorage, onWillShutdown: ILifecycleService['onWillShutdown']): void {
		if (!(this.input instanceof ChatInputPart)) throw new Error('This Chat input owns its draft lifecycle');
		this.input.bindDraftStorage(this.model, storage, onWillShutdown);
	}

	captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
		return this.input.captureDraft();
	}

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void {
		this.input.restoreDraft(draft);
	}

	appendToDraft(text: string): void {
		this.input.appendToDraft(text);
	}

	public acceptInput(value?: string, options?: IChatAcceptInputOptions): Promise<void> {
		// Sent edits branch through the inline form. Global send commands must not submit the main draft.
		if (this.listWidget.isEditingRequest) return Promise.resolve();
		return this.queueEditor.value ? this.queueEditor.value.acceptInput(value, options) : this.input.acceptInput(value, options);
	}

	public async startEditing(request: string | QueuedMessage): Promise<void> {
		if (!this.visible || this.queueEditor.value) return;
		if (typeof request === 'string') {
			if (!this.isTranscriptProgressActive) this.listWidget.startEditing(request);
			return;
		}
		if (this.listWidget.isEditingRequest) return;
		const editor = this.instantiationService.createInstance(ChatQueueEditor, this, request);
		this.queueEditor.value = editor;
		try { await editor.show(); }
		finally { if (this.queueEditor.value === editor) this.queueEditor.clear(); }
	}

	public cancelEditing(): boolean { return this.listWidget.cancelEditing(); }

	private reportVoiceError(error: unknown): void {
		if (!this.isDisposed && !isCancellationError(error)) {
			this.notifications.error(localize('chat.voice.requestFailed', 'The voice request failed: {0}', error instanceof Error ? error.message : String(error)));
		}
	}

	private async runVoice(operation: () => Promise<void>): Promise<void> {
		try { await operation(); }
		catch (error) { this.reportVoiceError(error); }
	}


	private async send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts: readonly ChatContextAttachment[] = [], appSource?: Parameters<IChatMcpAppDelegate['sendMessage']>[0], submissionSignal?: AbortSignal, queue?: ChatRequestQueueKind): Promise<void> {
		const model = this.model;
		const generation = model.composerGeneration;
		if (this.isDisposed || submissionSignal?.aborted) throw canceled();
		if (this.viewOptions?.submitHandler && await this.viewOptions.submitHandler(text, mode, contexts, submissionSignal)) {
			return;
		}
		if (this.isDisposed || submissionSignal?.aborted || generation !== model.composerGeneration) { throw canceled(); }

		this.submittedMessage = true;
		this.updateConversationState();
		try {
			const resolvedContexts = await Promise.all(contexts.map(resolveChatContextAttachment));
			if (this.isDisposed || submissionSignal?.aborted || generation !== model.composerGeneration) throw canceled();
			if (appSource) this.appContextId(appSource);
			const options = appSource ? { source: { sessionId: appSource.sessionId, threadId: appSource.threadId }, signal: submissionSignal } : submissionSignal ? { signal: submissionSignal } : undefined;
			await model.send(text, mode, skills, resolvedContexts, queue ? { ...options, queue } : options);
		} catch (error) {
			if (!this.isDisposed && !submissionSignal?.aborted && generation === model.composerGeneration && model.items.length === 0) {
				this.submittedMessage = false;
				this.updateConversationState();
			}
			throw error;
		}
	}

	private appContextId(source: Parameters<IChatMcpAppDelegate['sendMessage']>[0]): string {
		if (this.isDisposed || source.sessionId !== this.model.sessionId || source.threadId !== this.model.threadId) throw new Error(localize('chat.mcpApp.chatUnavailable', 'The App conversation is no longer available.'));
		return JSON.stringify(['mcpApp', source.sessionId, source.threadId, source.itemId, source.contentIndex]);
	}

	public async retryFailedTurn(turnId?: string): Promise<void> {
		if (this.isDisposed || !this.visible || this.model.inputState.aiDisabled) { return; }
		const action = [...this.model.items].reverse().find(item => item.action?.type === 'retry' && (!turnId || item.action.turnId === turnId))?.action;
		if (action?.type === 'retry') { await this.model.retryFailedTurn?.(action.turnId); }
	}

	private async handleTurnErrorAction(action: ChatTurnErrorAction): Promise<void> {
		switch (action.type) {
			case 'retry':
				await this.retryFailedTurn(action.turnId);
				return;
			case 'chooseModel':
				this.input.openModelPicker();
				return;
			case 'startNewChat':
				this.createUntitledSession();
				return;
			case 'revise':
				this.input.focus();
				return;
		}
	}

	private syncRecapPresence(visible = this.visible): void {
		if (!this.model.reportRecapPresence) return;
		const { sessionId, threadId } = this.model;
		const document = this.element.ownerDocument;
		const listeningDocument = visible ? document : undefined;
		this.recapBlurListener?.update(visible);
		if (this.recapDocument !== listeningDocument) {
			this.recapDocument = listeningDocument;
			this.recapFocusListeners.clear();
			if (listeningDocument) {
				const report = () => this.syncRecapPresence();
				if (listeningDocument.defaultView) {
					this.recapFocusListeners.add(addDisposableListener(listeningDocument.defaultView, 'focus', report));
				}
				this.recapFocusListeners.add(addDisposableListener(listeningDocument, 'visibilitychange', report));
			}
		}
		const focused = document.visibilityState !== 'hidden' && document.hasFocus();
		const view = visible && sessionId && threadId ? { sessionId, threadId, focused } : undefined;
		const previous = this.recapView;
		if (previous?.sessionId === view?.sessionId && previous?.threadId === view?.threadId && previous?.focused === view?.focused) return;
		this.recapView = view;
		this.recapPresencePending = this.recapPresencePending.then(async () => {
			if (previous && (previous.sessionId !== view?.sessionId || previous.threadId !== view.threadId)) {
				await this.model.reportRecapPresence!(previous.sessionId, previous.threadId, this.recapSurface, null).catch(() => { });
			}
			if (view) await this.model.reportRecapPresence!(view.sessionId, view.threadId, this.recapSurface, view.focused).catch(() => { });
		});
	}

	private render(): void {
		this.syncRecapPresence();
		const conversationId = this.model.threadId ?? this.model.inputState.draftIdentity?.id;
		if (this.displayedConversationId !== conversationId) {
			this.displayedConversationId = conversationId;
			this.submittedMessage = false;
		}
		this.syncIdentity();
		const voice = this.voiceSessionController;
		const voiceWidget = this.voiceWidget;
		voice?.setSource(this.model.sessionId && this.model.threadId ? { sessionId: this.model.sessionId, threadId: this.model.threadId } : undefined, this.model.untitledSessionId);
		if (voice && voiceWidget) {
			const focused = this.element.ownerDocument.activeElement;
			if (!voice.isActive && voiceWidget.element.contains(focused)) this.input.focus();
			voiceWidget.element.hidden = !voice.isActive;
			voiceWidget.setConnected(voice.isConnected);
			voiceWidget.setConnecting(voice.isActive && !voice.isConnected);
			voiceWidget.setMuted(voice.isMuted);
			voiceWidget.setInputMode(voice.inputMode);
			voiceWidget.setVoiceState(voice.isListening ? 'listening' : 'idle');
			voiceWidget.setStatusText(voice.isConnected
				? voice.isMuted ? localize('agentsVoice.mutedStatus', 'Microphone muted') : voice.inputMode === 'pushToTalk'
					? voice.isListening ? localize('agentsVoice.listening', 'Listening…') : localize('agentsVoice.readyPtt', 'Press and hold to speak')
					: localize('agentsVoice.listening', 'Listening…')
				: localize('agentsVoice.connecting', 'Connecting…'));
		}
		this.goalBanner.setGoal(this.model.goal);
		this.renderReadOnlyBanner();
		this.renderHistoryStatus();
		this.renderOlderHistory();
		const items = this.model.items;
		const working = this.responseWorking;
		this.updateConversationState(items.length > 0 || working);
		if (this.model.draft) {
			const { phase } = this.model.inputState;
			this.listWidget.setBusy(phase === 'loading' || phase === 'submitting');
		}
		this.listWidget.render(items, working);
		const inputState = this.model.inputState;
		this.input.render({
			...inputState,
			followups: chatResponseFollowups(this.model.thread?.turns.at(-1)),
			toolInvocations: items.flatMap(item => item.toolInvocation ? [item.toolInvocation] : []),
			toolInvocation: items.find(item => item.toolInvocation?.call.itemId === inputState.interaction?.itemId)?.toolInvocation,
			conversation: this.model.sessionId && this.model.threadId ? { sessionId: this.model.sessionId, threadId: this.model.threadId } : undefined,
		});
	}

	private get responseWorking(): boolean {
		const { phase, canInterrupt, aiDisabled, inputBlocked, error, status } = this.model.inputState;
		return !aiDisabled && !inputBlocked && !error && status === undefined
			&& (phase === 'submitting' || phase === 'ready' && canInterrupt);
	}

	private renderReadOnlyBanner(): void {
		const archived = this.model.thread?.status === 'archived';
		const wasArchived = this.readOnlyBanner.visible;
		const active = this.element.ownerDocument.activeElement;
		const restoreFocus = archived ? this.input.element.contains(active) : this.readOnlyBanner.domNode.contains(active);
		this.element.classList.toggle('ash-chat-readonly', archived);
		this.readOnlyBanner.render(archived, archived && this.model.canRestoreArchivedSession ? this.model.sessionId : undefined);
		if (archived === wasArchived) return;
		this.input.setVisible(this.visible && !archived);
		if (restoreFocus && this.visible) this.focusInput();
	}

	private renderHistoryStatus(): void {
		const status = this.model.historyStatus;
		this.historyStatusElement.hidden = !status;
		this.historyMessage.textContent = status?.message ?? '';
		this.historyAction.label = status?.action.label ?? '';
		const recovering = this.historyRecovery?.status === status && this.historyRecovery?.generation === this.model.composerGeneration;
		this.historyAction.enabled = !!status && !recovering;
		this.historyStatusElement.setAttribute('aria-busy', String(recovering));
	}

	private renderOlderHistory(): void {
		const history = this.model.olderHistory;
		this.olderHistoryElement.hidden = !history;
		this.olderHistoryElement.setAttribute('aria-busy', String(!!history?.loading));
		this.olderHistoryButton.enabled = !!history && !history.loading;
		this.olderHistoryButton.label = history?.error
			? localize('chat.history.retryOlder', 'Retry earlier messages')
			: localize('chat.history.loadOlder', 'Load earlier messages');
		this.olderHistoryMessage.textContent = history?.loading
			? localize('chat.history.loadingOlder', 'Loading earlier messages…')
			: history?.error ?? '';
	}

	private async loadOlderHistory(): Promise<void> {
		if (!this.model.loadOlderHistory || !this.olderHistoryButton.enabled) return;
		const generation = this.model.composerGeneration;
		const focused = this.olderHistoryButton.hasFocus();
		try {
			await this.model.loadOlderHistory();
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(String(error));
		} finally {
			if (!this.isDisposed && focused && generation === this.model.composerGeneration && !this.element.hidden) {
				const active = this.element.ownerDocument.activeElement;
				if (active === this.olderHistoryButton.domNode || active === this.element.ownerDocument.body) {
					if (this.model.olderHistory) this.olderHistoryButton.focus();
					else this.listWidget.focusReadingPosition();
				}
			}
		}
	}

	private async recoverHistory(): Promise<void> {
		const status = this.model.historyStatus;
		if (!status || !this.historyAction.enabled) return;
		const recovery = { status, generation: this.model.composerGeneration };
		const wasFocused = this.historyAction.hasFocus();
		this.historyRecovery = recovery;
		this.renderHistoryStatus();
		try {
			await status.action.run();
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(String(error));
		} finally {
			if (!this.isDisposed && this.historyRecovery === recovery) {
				this.historyRecovery = undefined;
				this.renderHistoryStatus();
				const document = this.element.ownerDocument;
				if (wasFocused && recovery.generation === this.model.composerGeneration && !this.element.hidden && (document.activeElement === this.historyAction.domNode || document.activeElement === document.body)) {
					if (this.model.historyStatus) this.historyAction.focus(); else this.focus();
				}
			}
		}
	}

	private updateConversationState(hasTranscript = this.model.items.length > 0 || this.responseWorking): void {
		const hasConversation = this.submittedMessage || hasTranscript;
		this.element.classList.toggle('empty', !hasConversation);
		this.element.classList.toggle('has-conversation', hasConversation);
		const input = this.model.inputState;
		const welcomeTitle = this.viewOptions?.welcomeTitle?.get();
		const showWelcome = this.viewOptions?.showWelcome !== false && !hasConversation && !input.aiDisabled
			&& (welcomeTitle === undefined ? this.model.untitledSessionId !== undefined && !input.inputBlocked : !!welcomeTitle)
			&& (!this.voiceWidget || !this.voiceSessionController?.isActive);
		// Let the host style the welcome state without watching transcript DOM mutations.
		this.element.classList.toggle('ash-chat-show-welcome', showWelcome);
		this.welcome.render(showWelcome ? {
			title: welcomeTitle ?? (input.mode === 'ask'
				? localize('chat.welcome.ask', 'Ask about your code')
				: input.mode === 'agent'
					? localize('chat.welcome.agent', 'Build with Agent')
					: localize('chat.welcome.start', 'Start a conversation')),
			message: localize('chat.welcome.verify', 'Check important details in AI-generated responses.'),
		} : undefined);
	}

	private syncIdentity(): void {
		const sessionId = this.model.sessionId;
		const threadId = this.model.threadId;
		const untitledSessionId = this.model.untitledSessionId;
		if (sessionId) this.element.dataset.sessionId = sessionId;
		else this.element.removeAttribute('data-session-id');
		if (threadId) this.element.dataset.threadId = threadId;
		else this.element.removeAttribute('data-thread-id');
		if (untitledSessionId) this.element.dataset.untitledSessionId = untitledSessionId;
		else this.element.removeAttribute('data-untitled-session-id');
	}
}

export async function openChatMarkdownLink(
	target: string,
	openerService: IOpenerService | undefined,
	editorService: Pick<IEditorService, 'openEditor'> | undefined,
	configuration?: IConfigurationService,
): Promise<void> {
	if (target.startsWith('#') || target.startsWith(`${Schemas.internal}:`)) return;
	if (target.startsWith(`${Schemas.command}:`)) {
		if (openerService) await openerService.open(target, { allowCommands: true, fromUserGesture: true });
		return;
	}
	if (/^file:/iu.test(target)) {
		const reference = parseInlineFileReference(target);
		if (reference && editorService) {
			const selection = reference.selection;
			const range = selection && new Range(selection.startLineNumber, selection.startColumn,
				selection.endLineNumber ?? selection.startLineNumber, selection.endColumn ?? selection.startColumn);
			const preferredEditorId = getEditorOverrideForChatResource(reference.uri, configuration);
			await editorService.openEditor({ resource: reference.uri }, { selection: range, ...(preferredEditorId ? { preferredEditorId } : {}) });
		}
		return;
	}
	const resource = URI.parse(target);
	if (resource.scheme === OPEN_SESSION_LINK_SCHEME) {
		if (openerService) await openerService.open(resource, { fromUserGesture: true });
		return;
	}
	if (resource.scheme === Schemas.vscodeNotebookCell) {
		if (editorService) await editorService.openEditor({ resource });
		return;
	}
	if (isEditorResourceScheme(resource.scheme)) {
		const { uri, selection } = extractSelection(resource);
		const workspaceResource = resolveMarkdownWorkspaceResource(uri);
		if (workspaceResource && editorService) {
			const range = selection && new Range(selection.startLineNumber, selection.startColumn,
				selection.endLineNumber ?? selection.startLineNumber, selection.endColumn ?? selection.startColumn);
			const preferredEditorId = getEditorOverrideForChatResource(workspaceResource, configuration);
			await editorService.openEditor({ resource: workspaceResource }, range || preferredEditorId ? {
				...(range ? { selection: range } : {}), ...(preferredEditorId ? { preferredEditorId } : {}),
			} : undefined);
		}
		return;
	}
	if (openerService) await openerService.open(target, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true });
}

function isEditorResourceScheme(scheme: string): boolean {
	return scheme === Schemas.file
		|| scheme === ASH_REMOTE_SCHEME
		|| scheme === Schemas.vscodeFileResource
		|| scheme === Schemas.vscodeRemote
		|| scheme === Schemas.vscodeRemoteResource
		|| scheme === Schemas.vscodeNotebookCell;
}

/** Maps direct workspace addresses; transport URLs without a remote identity cannot be resolved here. */
export function resolveMarkdownWorkspaceResource(resource: URI): URI | undefined {
	if (resource.query || resource.fragment) return undefined;
	if (resource.scheme === Schemas.file) return resource;
	if (resource.scheme === ASH_REMOTE_SCHEME) {
		try { getRemoteWorkspacePath(resource); return resource; }
		catch { return undefined; }
	}
	if (resource.scheme === Schemas.vscodeFileResource) {
		return resource.authority === 'vscode-app' ? URI.parse(`file://${resource.toEncodedComponents().path}`) : undefined;
	}
	if (resource.scheme === Schemas.vscodeRemote || resource.scheme === Schemas.vscodeRemoteResource) {
		const match = /^ssh-remote\+([A-Za-z0-9._-]+)$/u.exec(resource.authority);
		if (!match) return undefined;
		try { return createSshRemoteWorkspaceUri(match[1]!, resource.path); }
		catch { return undefined; }
	}
	return undefined;
}
