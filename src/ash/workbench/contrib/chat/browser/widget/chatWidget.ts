import type { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { readWorkspaceChanges } from './input/chatInput.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ChatSubmissionOptions } from '../../../../services/chat/common/chatService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { approvalModeDefinition } from '../../../../../platform/agentHost/common/approvalModes.js';
import { OPEN_SESSION_LINK_SCHEME } from '../../../../../platform/agentHost/common/openSessionLink.js';
import { localize } from '../../../../../nls.js';
import './media/chat.css';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from "../../../../../base/common/lifecycle.js";
import { Emitter, type Event } from "../../../../../base/common/event.js";
import { canceled, isCancellationError } from "../../../../../base/common/errors.js";
import type { ICommandService } from "../../../../../platform/commands/common/commands.js";
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../../../platform/contextview/browser/contextView.js";
import type { AgentResponse, ApprovalMode, ChatAgent, ChatMode, ModelRef, SessionId, ThreadGoal, ThreadId } from "../../../../services/chat/common/chatService.js";
import type { ChatInputDelegate } from "./input/chatInput.js";
import type { SkillReference } from "../../../../../platform/agentHost/common/appServerApi.js";
import { ChatInputPart, type IChatInputPart, type IChatDraftStorage } from "./input/chatInputPart.js";
import type { ChatTurnErrorAction } from "./chatListItems.js";
import { ChatListWidget } from "./chatListWidget.js";
import type { ChatInputState } from "./input/chatInput.js";
import type { ModelReasoningEffort } from "../../../../services/chat/common/modelCatalog.js";
import type { IChatListItem } from "./chatListItems.js";
import type { ResolvedChatContext } from "../../../../services/chat/common/chatContextService.js";
import { getActiveWindow, h } from "../../../../../base/browser/dom.js";
import { generateUuid } from '../../../../../base/common/uuid.js';
import { AgentsVoiceWidget } from '../../../agentsVoice/browser/agentsVoiceWidget.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import type { IChatSessionHistoryStatus } from '../../../../../platform/chat/common/chatSessionHistory.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import type { ChatContextAttachment } from "../../../../services/chat/common/chatContextService.js";
import type { IOpenerService } from "../../../../../platform/opener/common/opener.js";
import type { IEditorService } from "../../../../services/editor/common/editorService.js";
import { URI } from "../../../../../base/common/uri.js";
import { Schemas } from "../../../../../base/common/network.js";
import { ASH_REMOTE_SCHEME, createSshRemoteWorkspaceUri, getRemoteWorkspacePath } from '../../../../../platform/remote/common/remote.js';
import { OPEN_CHAT_CHANGES_COMMAND_ID, OPEN_CHAT_SETTINGS_COMMAND_ID, OPEN_CHAT_PERMISSIONS_COMMAND_ID, OPEN_GUARDIAN_SETUP_COMMAND_ID } from "../../common/chat.js";
import { OpenSettingsCommandId } from '../../../preferences/common/preferences.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatInputEditors } from './input/chatInputEditorRegistry.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';
import type { IChatMcpAppDelegate } from './chatContentParts/toolInvocationParts/chatMcpAppSubPart.js';
import { VoiceSessionController, pickVoiceConversation } from '../voiceClient/voiceSessionController.js';
import type { AgentVoiceTaskRequest } from '../../../../../platform/agentHost/common/agent.js';
import { IChatWidgetService, type IChatWidget } from '../chat.js';

/** The presentation consumes one conversation model owned by its product. */
export interface IChatWidgetModel extends IDisposable {
	readonly onDidChange: Event<void>;
	readonly onDidChangeComposer: Event<void>;
	readonly composerGeneration: number;
	readonly sessionId: SessionId | undefined;
	readonly threadId: ThreadId | undefined;
	readonly untitledSessionId: string | undefined;
	readonly goal: ThreadGoal | undefined;
	readonly items: readonly IChatListItem[];
	readonly inputState: ChatInputState;
	readonly historyStatus?: IChatSessionHistoryStatus;
	readonly olderHistory?: { readonly loading: boolean; readonly error?: string; };
	loadOlderHistory?(): Promise<void>;
	prepareConversation?(): Promise<{ readonly sessionId: string; readonly threadId: string; }>;
	send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], submissionOptions?: ChatSubmissionOptions): Promise<void>;
	executeServerCommand(name: string, argumentsText: string, submissionSignal?: AbortSignal): Promise<void>;
	interrupt(): Promise<void>;
	refreshChanges(): Promise<void>;
	selectModel(model: ModelRef): Promise<void>;
	selectReasoningEffort(effort: ModelReasoningEffort | undefined): Promise<void>;
	selectAutomaticModel(): Promise<void>;
	listAgents(): Promise<readonly ChatAgent[]>;
	selectAgent(agent: ChatAgent | undefined): void;
	selectMode(mode: ChatMode): void;
	selectApprovalMode(mode: ApprovalMode): void;
	resolveInteraction(response: AgentResponse): Promise<void>;
	retryFailedTurn(turnId: string): Promise<void>;
}

/** Owns the content and interaction state for one local or durable Chat tab. */
export class ChatWidget<TModel extends IChatWidgetModel = IChatWidgetModel> extends Disposable implements IChatWidget {
	readonly element: HTMLElement;
	private readonly hidden = this._register(new Emitter<void>());
	readonly onDidHide = this.hidden.event;
	private readonly voiceSessionController: VoiceSessionController;
	private readonly voiceWidget: AgentsVoiceWidget;
	readonly model: TModel;
	private listWidget: ChatListWidget;
	private readonly inputPart: IChatInputPart;
	private readonly goalElement: HTMLDivElement;
	private readonly olderHistoryElement: HTMLDivElement;
	private readonly olderHistoryButton: Button;
	private readonly olderHistoryMessage: HTMLSpanElement;
	private readonly historyStatusElement: HTMLDivElement;
	private readonly historyMessage: HTMLSpanElement;
	private readonly historyAction: Button;
	private historyRecovery: { readonly status: IChatSessionHistoryStatus; readonly generation: number; } | undefined;
	private submittedMessage = false;
	private displayedThreadId: ThreadId | undefined;

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
		@IInstantiationService instantiationService: IInstantiationService,
		@IDialogService dialogs: IDialogService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IChatWidgetService widgets: IChatWidgetService,
	) {
		super();
		this.model = this._register(model);
		this.voiceSessionController = this._register(instantiationService.createInstance(VoiceSessionController, async (request: AgentVoiceTaskRequest, signal: AbortSignal) => {
			if (signal.aborted || this.isDisposed || this.model.sessionId !== request.sessionId || this.model.threadId !== request.threadId) throw canceled();
			// The original composer/model owns mode, queue, steering and approval. Speech remains low-trust context.
			await this.model.send(localize('chat.voice.task.submit', 'Handle the request I just spoke.'), this.model.inputState.mode, undefined, [{ name: localize('chat.voice.task.context', 'Voice request'), content: request.transcript }], { commandId: request.commandId, source: { sessionId: request.sessionId, threadId: request.threadId }, signal });
		}, (error: unknown) => notifications.error(localize('chat.voice.requestFailed', 'The voice request failed: {0}', String(error))), this.model.prepareConversation ? async () => {
			const source = await this.model.prepareConversation!();
			if (this.isDisposed || source.sessionId !== this.model.sessionId || source.threadId !== this.model.threadId) throw canceled();
			return source;
		} : undefined));
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.id = panelId;
		this.element.className = "ash-chat";
		this.element.setAttribute("role", "tabpanel");
		this.element.hidden = true;
		container.append(this.element);
		this.goalElement = h(ownerDocument, "div");
		this.goalElement.className = "ash-chat-goal";
		this.goalElement.hidden = true;
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
		const listWidgets = ChatListWidget.instantiateObservable(instantiationService, this._store, h(ownerDocument, 'div'), {
			imageResourceLoader,
			mcpAppDelegate: {
				updateModelContext: (source, text, images = []) => {
					const id = this.appContextId(source);
					const model = this.inputPart.attachmentModel;
					const owned = (attachment: ChatContextAttachment) => attachment.id === id || attachment.id.startsWith(`${id}:image:`);
					for (const attachment of model.attachments.filter(owned)) model.delete(attachment.id);
					const lifetime = new DisposableStore();
					const name = localize('chat.mcpApp.contextLabel', 'App context');
					const attachments: ChatContextAttachment[] = [
						...(text ? [{ id, kind: 'mcpApp', lifetime: 'source' as const, name, resolve: async () => ({ name, content: text }) }] : []),
						...images.map((image, index) => ({ ...image, id: `${id}:image:${index}`, lifetime: 'source' as const })),
					];
					for (const attachment of attachments) {
						model.addContext(attachment);
						lifetime.add(toDisposable(() => { if (model.attachments.includes(attachment)) model.delete(attachment.id); }));
					}
					return lifetime;
				},
				sendMessage: async (source, text, signal, images = []) => {
					const id = this.appContextId(source);
					// An App follow-up includes its own source context, never a user's unsent draft or files.
					const contexts = [...this.inputPart.attachmentModel.attachments.filter(attachment => attachment.id === id || attachment.id.startsWith(`${id}:image:`)), ...images];
					await this.send(text, this.model.inputState.mode, undefined, contexts, source, signal);
				},
			} satisfies IChatMcpAppDelegate,
			onDidRequestLink: (target: string) => {
				void openChatMarkdownLink(target, openerService, editorService).catch(error => console.error("Could not open Markdown link", error));
			},
			onDidRequestMemoryReference: (reference: string) => { void commandService.executeCommand('ash.memories.openReference', reference).catch(error => console.error('Could not open memory reference', error)); },
			onDidRequestErrorAction: (action: ChatTurnErrorAction) => void this.handleTurnErrorAction(action).catch(() => undefined),
		});
		this.listWidget = listWidgets.get();
		const voiceClient = this.voiceSessionController;
		const inputDelegate: ChatInputDelegate = {
			voiceConversation: {
				get isAvailable() { return voiceClient.isAvailable && !model.inputState.aiDisabled; },
				get isActive() { return voiceClient.isActive; },
				get isConnected() { return voiceClient.isConnected; },
				toggle: () => this.runVoice(() => {
					if (voiceClient.isActive) return voiceClient.disconnect();
					if (model.inputState.aiDisabled) throw new Error(localize('chat.ai.disabled.message', 'AI features are disabled. Turn off Disable AI features in Settings to send messages.'));
					return voiceClient.connect(ownerDocument.defaultView!, (connections, signal) => pickVoiceConversation(this.quickInput, connections, signal));
				}),
				interrupt: () => this.runVoice(() => voiceClient.stopSpeaking()),
			},
			send: (text, mode, skills, contexts, submissionSignal) => this.send(text, mode, skills, contexts, undefined, submissionSignal),
			executeCommand: (invocation) => invocation.commandId === OPEN_CHAT_PERMISSIONS_COMMAND_ID || invocation.commandId === OPEN_GUARDIAN_SETUP_COMMAND_ID
				? commandService.executeCommand(invocation.commandId, this.model, invocation.argumentsText)
				: invocation.argumentsText ? commandService.executeCommand(invocation.commandId, invocation.argumentsText) : commandService.executeCommand(invocation.commandId),
			executeServerCommand: (invocation, submissionSignal) => invocation.name === "advisor" && !invocation.argumentsText.trim()
				? commandService.executeCommand(OPEN_CHAT_SETTINGS_COMMAND_ID)
				: this.model.executeServerCommand(invocation.name, invocation.argumentsText, submissionSignal),
			interrupt: () => this.model.interrupt(),
			openChanges: async revision => {
				try { await commandService.executeCommand(OPEN_CHAT_CHANGES_COMMAND_ID, this.model.sessionId, this.model.threadId, revision); }
				finally { void this.model.refreshChanges(); }
			},
			readWorkspaceChanges: () => readWorkspaceChanges(commandService),
			selectModel: (model) => this.model.selectModel(model),
			selectReasoningEffort: effort => this.model.selectReasoningEffort(effort),
			selectAutomaticModel: () => this.model.selectAutomaticModel(),
			listAgents: () => this.model.listAgents(),
			selectAgent: agent => this.model.selectAgent(agent),
			selectMode: mode => this.model.selectMode(mode),
			selectApprovalMode: async mode => {
				const identity = this.model.threadId ?? this.model.untitledSessionId;
				const definition = approvalModeDefinition(mode);
				if (definition.requiresConfirmation) {
					const result = await dialogs.confirm({
						message: localize('sessions.chat.permission.fullWarning', 'Skip most permission approvals?'),
						detail: localize('sessions.chat.permission.fullDetail', 'Commands may change or delete files and perform external actions without asking. File and network access limits still apply. Plan and Ask remain analysis modes.'),
						primaryButton: localize(definition.label.key, definition.label.text),
					});
					if (!result.confirmed) return;
				}
				if (!this.isDisposed && identity === (this.model.threadId ?? this.model.untitledSessionId)) this.model.selectApprovalMode(mode);
			},
			openModelSettings: (category = 'models') => commandService.executeCommand(OpenSettingsCommandId, { section: category }),
			resolveInteraction: (response) => this.model.resolveInteraction(response),
		};
		this.inputPart = this._register(createInputPart
			? createInputPart(this.element, inputDelegate)
			: instantiationService.createInstance(ChatInputPart, this.element, inputDelegate, contextMenuService, contextViewService, accessibleViewService, notifications, ChatInputEditors, [], { modePicker: 'visible', modelPickerPosition: 'leading' }));
		this._register(widgets.register(this));
		const voiceContainer = h(ownerDocument, 'div');
		let hold: string | undefined;
		this.voiceWidget = this._register(instantiationService.createInstance(AgentsVoiceWidget, voiceContainer, {
			openSession: () => this.inputPart.focus(),
			toggleMute: () => { void this.runVoice(() => voiceClient.setMuted(!voiceClient.isMuted)); },
			toggleInputMode: () => { void this.runVoice(() => voiceClient.setInputMode(voiceClient.inputMode === 'pushToTalk' ? 'openMic' : 'pushToTalk')); },
			pttDown: () => { hold = generateUuid(); const id = hold; void this.runVoice(() => voiceClient.pttDown(id)); },
			pttUp: () => { const id = hold; hold = undefined; if (id) void this.runVoice(() => voiceClient.pttUp(id)); },
			disconnect: () => { void this.runVoice(() => voiceClient.disconnect()); },
			stopPlayback: () => { void this.runVoice(() => voiceClient.stopSpeaking()); },
			closeWindow: () => this.inputPart.focus(),
			showSessionsPicker: () => this.inputPart.focus(),
		}, { showClose: false, showOnboarding: false, inputBoxLayout: true }));
		this.element.append(this.goalElement, this.olderHistoryElement, this.listWidget.element, this.historyStatusElement, voiceContainer, this.inputPart.element);
		this._register(listWidgets.onDidChange(widget => {
			const previous = this.listWidget;
			const state = previous.getViewState();
			previous.element.replaceWith(widget.element);
			this.listWidget = widget;
			widget.restoreViewState(state, this.model.items);
		}));
		this._register(this.model.onDidChangeComposer(() => this.inputPart.invalidatePendingInput()));
		this._register(this.model.onDidChange(() => {
			if (this.model.inputState.aiDisabled && this.voiceSessionController.isActive) void this.runVoice(() => this.voiceSessionController.disconnect());
			this.render();
		}));
		this._register(this.voiceSessionController.onDidChange(() => { if (!this.isDisposed) this.render(); }));
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
	get visible(): boolean { return !this.element.hidden; }
	get inputEditor() { return this.inputPart.inputEditor; }
	get isTranscriptProgressActive(): boolean { return this.model.inputState.inputBlocked === true || this.model.inputState.aiDisabled === true; }
	get onDidChangeViewModel(): Event<void> { return this.model.onDidChangeComposer; }

	setTabId(tabId: string | undefined): void {
		if (tabId) {
			this.element.setAttribute("aria-labelledby", tabId);
			this.element.removeAttribute("aria-label");
		} else {
			this.element.removeAttribute("aria-labelledby");
			this.element.setAttribute("aria-label", "Chat");
		}
	}

	setVisible(visible: boolean): void {
		const wasVisible = this.visible;
		this.element.hidden = !visible;
		if (wasVisible && !visible) this.hidden.fire();
		if (!visible && this.voiceSessionController.isActive) void this.runVoice(() => this.voiceSessionController.disconnect());
		this.inputPart.setVisible(visible);
		this.listWidget.setVisible(visible);
	}

	focus(): void {
		this.inputPart.focus();
	}
	/** A floating control starts through this Chat's original source and task dispatcher. */
	startVoiceConversation(): Promise<void> {
		return this.voiceSessionController.connect(getActiveWindow(), (connections, signal) => pickVoiceConversation(this.quickInput, connections, signal));
	}

	addContext(attachment: ChatContextAttachment): void {
		this.inputPart.addContext(attachment);
	}

	captureScreenshot(): Promise<void> {
		return this.inputPart.captureScreenshot();
	}

	bindDraftStorage(storage: IChatDraftStorage, onWillShutdown: ILifecycleService['onWillShutdown']): void {
		if (!(this.inputPart instanceof ChatInputPart)) throw new Error('This Chat input owns its draft lifecycle');
		this.inputPart.bindDraftStorage(this.model, storage, onWillShutdown);
	}

	captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
		return this.inputPart.captureDraft();
	}

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void {
		this.inputPart.restoreDraft(draft);
	}

	appendToDraft(text: string): void {
		this.inputPart.appendToDraft(text);
	}

	acceptInput(value?: string): Promise<void> {
		return this.inputPart.acceptInput(value);
	}

	private async runVoice(operation: () => Promise<void>): Promise<void> {
		try { await operation(); }
		catch (error) { if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(localize('chat.voice.requestFailed', 'The voice request failed: {0}', String(error))); }
	}


	private async send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts: readonly ChatContextAttachment[] = [], appSource?: Parameters<IChatMcpAppDelegate['sendMessage']>[0], submissionSignal?: AbortSignal): Promise<void> {
		const model = this.model;
		const generation = model.composerGeneration;
		if (this.isDisposed || submissionSignal?.aborted) throw canceled();
		this.submittedMessage = true;
		this.updateConversationState();
		try {
			const resolvedContexts = await Promise.all(contexts.map(context => context.resolve()));
			if (this.isDisposed || submissionSignal?.aborted || generation !== model.composerGeneration) throw canceled();
			if (appSource) this.appContextId(appSource);
			await model.send(text, mode, skills, resolvedContexts, appSource ? { source: { sessionId: appSource.sessionId, threadId: appSource.threadId }, signal: submissionSignal } : submissionSignal ? { signal: submissionSignal } : undefined);
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

	private async handleTurnErrorAction(action: ChatTurnErrorAction): Promise<void> {
		switch (action.type) {
			case "retry":
				await this.model.retryFailedTurn(action.turnId);
				return;
			case "chooseModel":
				this.inputPart.openModelSelector();
				return;
			case "startNewChat":
				this.createUntitledSession();
				return;
			case "revise":
				this.inputPart.focus();
				return;
		}
	}

	private render(): void {
		if (this.displayedThreadId !== this.model.threadId) {
			this.displayedThreadId = this.model.threadId;
			this.submittedMessage = false;
		}
		this.syncIdentity();
		this.voiceSessionController.setSource(this.model.sessionId && this.model.threadId ? { sessionId: this.model.sessionId, threadId: this.model.threadId } : undefined, this.model.untitledSessionId);
		const voice = this.voiceSessionController;
		const focused = this.element.ownerDocument.activeElement;
		if (!voice.isActive && this.voiceWidget.element.contains(focused)) this.inputPart.focus();
		this.voiceWidget.element.hidden = !voice.isActive;
		this.voiceWidget.setConnected(voice.isConnected);
		this.voiceWidget.setConnecting(voice.isActive && !voice.isConnected);
		this.voiceWidget.setMuted(voice.isMuted);
		this.voiceWidget.setInputMode(voice.inputMode);
		this.voiceWidget.setVoiceState(voice.isListening ? 'listening' : 'idle');
		this.voiceWidget.setStatusText(voice.isConnected
			? voice.isMuted ? localize('agentsVoice.mutedStatus', 'Microphone muted') : voice.inputMode === 'pushToTalk'
				? voice.isListening ? localize('agentsVoice.listening', 'Listening…') : localize('agentsVoice.readyPtt', 'Press and hold to speak')
				: localize('agentsVoice.listening', 'Listening…')
			: localize('agentsVoice.connecting', 'Connecting…'));
		this.renderGoal();
		this.renderHistoryStatus();
		this.renderOlderHistory();
		const items = this.model.items;
		this.updateConversationState(items.length > 0);
		this.listWidget.render(items);
		this.inputPart.render(this.model.inputState);
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
					else this.listWidget.element.querySelector<HTMLElement>('.ash-chat-transcript')?.focus({ preventScroll: true });
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

	private renderGoal(): void {
		const goal = this.model.goal;
		if (!goal) {
			this.goalElement.hidden = true;
			this.goalElement.textContent = "";
			return;
		}
		this.goalElement.hidden = false;
		const usage = goal.tokenBudget === null || goal.tokenBudget === undefined
			? `${formatNumber(goal.tokensUsed)} tokens`
			: `${formatNumber(goal.tokensUsed)}/${formatNumber(goal.tokenBudget)} tokens`;
		this.goalElement.textContent = `Goal · ${goal.status} · ${usage} · ${goal.objective}`;
	}

	private updateConversationState(hasTranscript = this.model.items.length > 0): void {
		const hasConversation = this.submittedMessage || hasTranscript;
		this.element.classList.toggle("empty", !hasConversation);
		this.element.classList.toggle("has-conversation", hasConversation);
	}

	private syncIdentity(): void {
		const sessionId = this.model.sessionId;
		const threadId = this.model.threadId;
		const untitledSessionId = this.model.untitledSessionId;
		if (sessionId) this.element.dataset.sessionId = sessionId;
		else this.element.removeAttribute("data-session-id");
		if (threadId) this.element.dataset.threadId = threadId;
		else this.element.removeAttribute("data-thread-id");
		if (untitledSessionId) this.element.dataset.untitledSessionId = untitledSessionId;
		else this.element.removeAttribute("data-untitled-session-id");
	}
}

export async function openChatMarkdownLink(
	target: string,
	openerService: IOpenerService | undefined,
	editorService: IEditorService | undefined,
): Promise<void> {
	if (target.startsWith("#") || target.startsWith(`${Schemas.internal}:`)) return;
	if (target.startsWith(`${Schemas.command}:`)) {
		if (openerService) await openerService.open(target, { allowCommands: true, fromUserGesture: true });
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
		const workspaceResource = resolveMarkdownWorkspaceResource(resource);
		if (workspaceResource && editorService) await editorService.openEditor({ resource: workspaceResource });
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

function formatNumber(value: number): string { return new Intl.NumberFormat("en-US").format(value); }
