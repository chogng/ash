import { AgentsVoiceWidget } from '../../../../../workbench/contrib/agentsVoice/browser/agentsVoiceWidget.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { VoiceSessionController, pickVoiceConversation } from '../../../../../workbench/contrib/chat/browser/voiceClient/voiceSessionController.js';
import type { AgentVoiceTaskRequest } from '../../../../../platform/agentHost/common/agentService.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { localize } from '../../../../../nls.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { ChatSubmissionOptions } from '../../../../../workbench/services/chat/common/chatService.js';
import { OPEN_CHAT_CHANGES_COMMAND_ID } from '../../../../../workbench/contrib/chat/common/chat.js';
import './media/chat.css';
import './media/chatListWidget.css';
import type { IChatMcpAppDelegate } from '../../../../../workbench/contrib/chat/browser/widget/chatContentParts/toolInvocationParts/chatMcpAppSubPart.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from "../../../../../base/common/lifecycle.js";
import type { Event } from "../../../../../base/common/event.js";
import type { ICommandService } from "../../../../../platform/commands/common/commands.js";
import type { AgentResponse, ApprovalMode, ChatAgent, ChatMode, ModelRef, SessionId, ThreadGoal, ThreadId } from "../../../../../workbench/services/chat/common/chatService.js";
import type { ChatInputDelegate } from "../../../../../workbench/contrib/chat/browser/widget/input/chatInput.js";
import type { SkillReference } from "../../../../../platform/agentHost/common/appServerApi.js";
import type { IChatInputPart } from "../../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js";
import type { ChatTurnErrorAction } from "../../../../../workbench/contrib/chat/browser/widget/chatListItems.js";
import { ChatListWidget } from "../../../../../workbench/contrib/chat/browser/widget/chatListWidget.js";
import type { ChatInputState } from "../../../../../workbench/contrib/chat/browser/widget/input/chatInput.js";
import type { ModelReasoningEffort } from "../../../../../workbench/services/chat/common/modelCatalog.js";
import type { IChatListItem } from "../../../../../workbench/contrib/chat/browser/widget/chatListItems.js";
import type { ResolvedChatContext } from "../../../../../workbench/services/chat/common/chatContextService.js";
import { getActiveWindow, h } from "../../../../../base/browser/dom.js";
import type { ChatContextAttachment } from "../../../../../workbench/services/chat/common/chatContextService.js";
import type { IOpenerService } from "../../../../../platform/opener/common/opener.js";
import type { IEditorService } from "../../../../../workbench/services/editor/common/editorService.js";
import { URI } from "../../../../../base/common/uri.js";
import { Schemas } from "../../../../../base/common/network.js";
import { ASH_REMOTE_SCHEME, createSshRemoteWorkspaceUri, getRemoteWorkspacePath } from '../../../../../platform/remote/common/remote.js';
import { OPEN_CHAT_SETTINGS_COMMAND_ID, OPEN_CHAT_PERMISSIONS_COMMAND_ID, OPEN_GUARDIAN_SETUP_COMMAND_ID } from "../../common/chat.js";
import { OpenSettingsCommandId } from '../../../../../workbench/contrib/preferences/common/preferences.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';

/** The presentation consumes one conversation model owned by its product. */
export interface ICoworkWidgetModel extends IDisposable {
	readonly onDidChange: Event<void>;
	readonly onDidChangeComposer: Event<void>;
	readonly composerGeneration: number;
	readonly sessionId: SessionId | undefined;
	readonly threadId: ThreadId | undefined;
	readonly untitledSessionId: string | undefined;
	readonly goal: ThreadGoal | undefined;
	readonly items: readonly IChatListItem[];
	readonly inputState: ChatInputState;
	prepareConversation?(): Promise<{ readonly sessionId: string; readonly threadId: string; }>;
	send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[], submissionOptions?: ChatSubmissionOptions): Promise<void>;
	executeServerCommand(name: string, argumentsText: string, submissionSignal?: AbortSignal): Promise<void>;
	interrupt(): Promise<void>;
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

/** Owns the content and interaction state for one local or durable conversation. */
export class CoworkWidget<TModel extends ICoworkWidgetModel = ICoworkWidgetModel> extends Disposable {
	readonly element: HTMLElement;
	readonly model: TModel;
	private listWidget: ChatListWidget;
	private readonly inputPart: IChatInputPart;
	private readonly goalElement: HTMLDivElement;
	private submittedMessage = false;
	private displayedThreadId: ThreadId | undefined;
	private readonly voiceSessionController: VoiceSessionController;
	private readonly voiceWidget: AgentsVoiceWidget;

	constructor(
		container: HTMLElement,
		panelId: string,
		model: TModel,
		private readonly createUntitledSession: () => void,
		commandService: ICommandService,
		openerService: IOpenerService | undefined,
		editorService: IEditorService | undefined,
		imageResourceLoader: ((resource: URI) => Promise<Blob>) | undefined,
		createInputPart: (container: HTMLElement, delegate: ChatInputDelegate) => IChatInputPart,
		@IInstantiationService instantiationService: IInstantiationService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.id = panelId;
		this.element.className = "ash-cowork";
		this.element.hidden = true;
		container.append(this.element);
		this.model = this._register(model);
		this.voiceSessionController = this._register(instantiationService.createInstance(VoiceSessionController, async (request: AgentVoiceTaskRequest, signal: AbortSignal) => {
			if (this.isDisposed || signal.aborted || this.model.sessionId !== request.sessionId || this.model.threadId !== request.threadId) throw canceled();
			await this.model.send(localize('chat.voice.task.submit', 'Handle the request I just spoke.'), this.model.inputState.mode, undefined, [{ name: localize('chat.voice.task.context', 'Voice request'), content: request.transcript }], { commandId: request.commandId, source: { sessionId: request.sessionId, threadId: request.threadId }, signal });
		}, (error: unknown) => this.reportVoiceError(error), this.model.prepareConversation ? async () => {
			const source = await this.model.prepareConversation!();
			if (this.isDisposed || source.sessionId !== this.model.sessionId || source.threadId !== this.model.threadId) throw canceled();
			return source;
		} : undefined));
		this.goalElement = h(ownerDocument, "div");
		this.goalElement.className = "ash-cowork-goal";
		this.goalElement.hidden = true;
		const listWidgets = ChatListWidget.instantiateObservable(instantiationService, this._store, h(ownerDocument, 'div'), {
			imageResourceLoader,
			classPrefix: 'ash-cowork',
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
		const voice = this.voiceSessionController;
		const inputDelegate: ChatInputDelegate = {
			voiceConversation: {
				get isAvailable() { return voice.isAvailable && !model.inputState.aiDisabled; },
				get isActive() { return voice.isActive; },
				get isConnected() { return voice.isConnected; },
				toggle: () => this.runVoice(() => {
					if (voice.isActive) return voice.disconnect();
					if (model.inputState.aiDisabled) throw new Error(localize('chat.ai.disabled.message', 'AI features are disabled. Turn off Disable AI features in Settings to send messages.'));
					return voice.connect(ownerDocument.defaultView!, (connections, signal) => pickVoiceConversation(this.quickInput, connections, signal));
				}),
				interrupt: () => this.runVoice(() => voice.stopSpeaking()),
			},
			send: (text, mode, skills, contexts, signal) => this.send(text, mode, skills, contexts, undefined, signal),
			executeCommand: (invocation) => invocation.commandId === OPEN_CHAT_PERMISSIONS_COMMAND_ID || invocation.commandId === OPEN_GUARDIAN_SETUP_COMMAND_ID
				? commandService.executeCommand(invocation.commandId, this.model, invocation.argumentsText)
				: invocation.argumentsText ? commandService.executeCommand(invocation.commandId, invocation.argumentsText) : commandService.executeCommand(invocation.commandId),
			executeServerCommand: (invocation, submissionSignal) => invocation.name === "advisor" && !invocation.argumentsText.trim()
				? commandService.executeCommand(OPEN_CHAT_SETTINGS_COMMAND_ID)
				: this.model.executeServerCommand(invocation.name, invocation.argumentsText, submissionSignal),
			interrupt: () => this.model.interrupt(),
			openChanges: () => commandService.executeCommand(OPEN_CHAT_CHANGES_COMMAND_ID, this.model.sessionId, this.model.threadId),
			selectModel: (model) => this.model.selectModel(model),
			selectReasoningEffort: effort => this.model.selectReasoningEffort(effort),
			selectAutomaticModel: () => this.model.selectAutomaticModel(),
			listAgents: () => this.model.listAgents(),
			selectAgent: agent => this.model.selectAgent(agent),
			selectMode: mode => this.model.selectMode(mode),
			openModelSettings: (category = 'models') => commandService.executeCommand(OpenSettingsCommandId, { section: category }),
			resolveInteraction: (response) => this.model.resolveInteraction(response),
		};
		this.inputPart = this._register(createInputPart(this.element, inputDelegate));
		const voiceContainer = h(ownerDocument, 'div');
		let hold: string | undefined;
		this.voiceWidget = this._register(instantiationService.createInstance(AgentsVoiceWidget, voiceContainer, {
			openSession: () => this.inputPart.focus(),
			toggleMute: () => { void this.runVoice(() => voice.setMuted(!voice.isMuted)); },
			toggleInputMode: () => { void this.runVoice(() => voice.setInputMode(voice.inputMode === 'pushToTalk' ? 'openMic' : 'pushToTalk')); },
			pttDown: () => { hold = generateUuid(); const id = hold; void this.runVoice(() => voice.pttDown(id)); },
			pttUp: () => { const id = hold; hold = undefined; if (id) void this.runVoice(() => voice.pttUp(id)); },
			disconnect: () => { void this.runVoice(() => voice.disconnect()); },
			stopPlayback: () => { void this.runVoice(() => voice.stopSpeaking()); },
			closeWindow: () => this.inputPart.focus(),
			showSessionsPicker: () => this.inputPart.focus(),
		}, { showClose: false, showOnboarding: false, inputBoxLayout: true }));
		this.element.append(this.goalElement, this.listWidget.element, voiceContainer, this.inputPart.element);
		this._register(listWidgets.onDidChange(widget => {
			const previous = this.listWidget;
			const state = previous.getViewState();
			previous.element.replaceWith(widget.element);
			this.listWidget = widget;
			widget.restoreViewState(state, this.model.items);
		}));
		this._register(this.model.onDidChange(() => {
			if (this.model.inputState.aiDisabled && this.voiceSessionController.isActive) void this.runVoice(() => this.voiceSessionController.disconnect());
			this.render();
		}));
		this._register(this.model.onDidChangeComposer(() => this.inputPart.invalidatePendingInput()));
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

	setVisible(visible: boolean): void {
		this.element.hidden = !visible;
		if (!visible && this.voiceSessionController.isActive) void this.runVoice(() => this.voiceSessionController.disconnect());
		this.inputPart.setVisible(visible);
		this.listWidget.setVisible(visible);
	}

	focus(): void {
		this.inputPart.focus();
	}

	addContext(attachment: ChatContextAttachment): void {
		this.inputPart.addContext(attachment);
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

	startVoiceConversation(): Promise<void> { return this.voiceSessionController.connect(getActiveWindow(), (connections, signal) => pickVoiceConversation(this.quickInput, connections, signal)); }

	private reportVoiceError(error: unknown): void { if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(localize('chat.voice.requestFailed', 'The voice request failed: {0}', String(error))); }
	private async runVoice(operation: () => Promise<void>): Promise<void> { try { await operation(); } catch (error) { this.reportVoiceError(error); } }

	private async send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts: readonly ChatContextAttachment[] = [], appSource?: Parameters<IChatMcpAppDelegate['sendMessage']>[0], signal?: AbortSignal): Promise<void> {
		const generation = this.model.composerGeneration;
		if (this.isDisposed || signal?.aborted) throw canceled();
		this.submittedMessage = true;
		this.updateConversationState();
		try {
			const resolvedContexts = await Promise.all(contexts.map(context => context.resolve()));
			if (this.isDisposed || signal?.aborted || generation !== this.model.composerGeneration) throw canceled();
			if (appSource) this.appContextId(appSource);
			await this.model.send(text, mode, skills, resolvedContexts, appSource ? { source: { sessionId: appSource.sessionId, threadId: appSource.threadId }, signal } : signal ? { signal } : undefined);
		} catch (error) {
			if (!this.isDisposed && !signal?.aborted && generation === this.model.composerGeneration && this.model.items.length === 0) {
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
		const items = this.model.items;
		this.updateConversationState(items.length > 0);
		this.listWidget.render(items);
		this.inputPart.render(this.model.inputState);
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
