import './media/chat.css';
import { Disposable, toDisposable, type IDisposable } from "../../../../../base/common/lifecycle.js";
import type { Event } from "../../../../../base/common/event.js";
import type { ICommandService } from "../../../../../platform/commands/common/commands.js";
import type { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../../../platform/contextview/browser/contextView.js";
import type { AgentResponse, ApprovalMode, ChatAgent, ChatMode, ModelRef, SessionId, ThreadGoal, ThreadId } from "../../../../services/chat/common/chatService.js";
import type { ChatInputDelegate } from "./input/chatInput.js";
import type { SkillReference } from "../../../../../platform/skills/common/skillApi.js";
import { ChatInputPart, type IChatInputPart } from "./input/chatInputPart.js";
import type { ChatTurnErrorAction } from "./chatListItems.js";
import { ChatListWidget } from "./chatListWidget.js";
import type { ChatInputState } from "./input/chatInput.js";
import type { ModelReasoningEffort } from "../../../../services/chat/common/modelCatalog.js";
import type { IChatListItem } from "./chatListItems.js";
import type { ResolvedChatContext } from "../../../../services/chat/common/chatContextService.js";
import { h } from "../../../../../base/browser/dom.js";
import type { ChatContextAttachment } from "../../../../services/chat/common/chatContextService.js";
import type { IOpenerService } from "../../../../../platform/opener/common/openerService.js";
import type { IEditorService } from "../../../../services/editor/common/editorService.js";
import { URI } from "../../../../../base/common/uri.js";
import { Schemas } from "../../../../../base/common/network.js";
import { ASH_REMOTE_SCHEME, createSshRemoteWorkspaceUri, getRemoteWorkspacePath } from '../../../../../platform/remote/common/remote.js';
import { OPEN_CHAT_SETTINGS_COMMAND_ID, OPEN_CHAT_PERMISSIONS_COMMAND_ID, OPEN_GUARDIAN_SETUP_COMMAND_ID } from "../../common/chat.js";
import { OpenSettingsCommandId } from '../../../preferences/common/preferences.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ChatInputEditors } from './input/chatInputEditorRegistry.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IOpenAgentsWindowOptions } from '../../../../../platform/native/common/nativeHost.js';

/** The presentation consumes one conversation model owned by its product. */
export interface IChatWidgetModel extends IDisposable {
	readonly onDidChange: Event<void>;
	readonly sessionId: SessionId | undefined;
	readonly threadId: ThreadId | undefined;
	readonly untitledSessionId: string | undefined;
	readonly goal: ThreadGoal | undefined;
	readonly items: readonly IChatListItem[];
	readonly inputState: ChatInputState;
	send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts?: readonly ResolvedChatContext[]): Promise<void>;
	executeServerCommand(name: string, argumentsText: string): Promise<void>;
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

/** Owns the content and interaction state for one local or durable Chat tab. */
export class ChatWidget<TModel extends IChatWidgetModel = IChatWidgetModel> extends Disposable {
	readonly element: HTMLElement;
	readonly model: TModel;
	private readonly listWidget: ChatListWidget;
	private readonly inputPart: IChatInputPart;
	private readonly goalElement: HTMLDivElement;
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
		notifications: INotificationService,
		openerService: IOpenerService | undefined,
		editorService: IEditorService | undefined,
		imageResourceLoader: ((resource: URI) => Promise<Blob>) | undefined,
		createInputPart: ((container: HTMLElement, delegate: ChatInputDelegate) => IChatInputPart) | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.id = panelId;
		this.element.className = "ash-chat";
		this.element.setAttribute("role", "tabpanel");
		this.element.hidden = true;
		container.append(this.element);
		this.model = this._register(model);
		this.goalElement = h(ownerDocument, "div");
		this.goalElement.className = "ash-chat-goal";
		this.goalElement.hidden = true;
		this.listWidget = this._register(instantiationService.createInstance(ChatListWidget, this.element, {
			imageResourceLoader,
			onDidRequestLink: (target: string) => {
				void openChatMarkdownLink(target, commandService, openerService, editorService).catch(error => console.error("Could not open Markdown link", error));
			},
			onDidRequestMemoryReference: (reference: string) => { void commandService.executeCommand('ash.memories.openReference', reference).catch(error => console.error('Could not open memory reference', error)); },
			onDidRequestErrorAction: (action: ChatTurnErrorAction) => void this.handleTurnErrorAction(action).catch(() => undefined),
		}));
		const inputDelegate: ChatInputDelegate = {
			send: (text, mode, skills, contexts) => this.send(text, mode, skills, contexts),
			executeCommand: (invocation) => invocation.commandId === OPEN_CHAT_PERMISSIONS_COMMAND_ID || invocation.commandId === OPEN_GUARDIAN_SETUP_COMMAND_ID
				? commandService.executeCommand(invocation.commandId, this.model, invocation.argumentsText)
				: invocation.argumentsText ? commandService.executeCommand(invocation.commandId, invocation.argumentsText) : commandService.executeCommand(invocation.commandId),
				executeServerCommand: (invocation) => invocation.name === "advisor" && !invocation.argumentsText.trim()
					? commandService.executeCommand(OPEN_CHAT_SETTINGS_COMMAND_ID)
					: this.model.executeServerCommand(invocation.name, invocation.argumentsText),
			interrupt: () => this.model.interrupt(),
			selectModel: (model) => this.model.selectModel(model),
			selectReasoningEffort: effort => this.model.selectReasoningEffort(effort),
			selectAutomaticModel: () => this.model.selectAutomaticModel(),
			listAgents: () => this.model.listAgents(),
			selectAgent: agent => this.model.selectAgent(agent),
			selectMode: mode => this.model.selectMode(mode),
			openModelSettings: (category = 'models') => commandService.executeCommand(OpenSettingsCommandId, category),
			resolveInteraction: (response) => this.model.resolveInteraction(response),
		};
		this.inputPart = this._register(createInputPart
			? createInputPart(this.element, inputDelegate)
			: instantiationService.createInstance(ChatInputPart, this.element, inputDelegate, contextMenuService, contextViewService, accessibleViewService, notifications, ChatInputEditors, []));
		this.element.append(this.goalElement, this.listWidget.element, this.inputPart.element);
		this._register(this.model.onDidChange(() => this.render()));
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
		this.element.hidden = !visible;
		this.inputPart.setVisible(visible);
		this.listWidget.setVisible(visible);
	}

	focus(): void {
		this.inputPart.focus();
	}

	addContext(attachment: ChatContextAttachment): void {
		this.inputPart.addContext(attachment);
	}

	captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void } | undefined> {
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

	private async send(text: string, mode: ChatMode, skills?: readonly SkillReference[], contexts: readonly ChatContextAttachment[] = []): Promise<void> {
		this.submittedMessage = true;
		this.updateConversationState();
		try {
			const resolvedContexts = await Promise.all(contexts.map(context => context.resolve()));
			await this.model.send(text, mode, skills, resolvedContexts);
		} catch (error) {
			if (this.model.items.length === 0) {
				this.submittedMessage = false;
				this.updateConversationState();
			}
			throw error;
		}
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
	commandService: ICommandService,
	openerService: IOpenerService | undefined,
	editorService: IEditorService | undefined,
): Promise<void> {
	if (target.startsWith("#") || target.startsWith(`${Schemas.internal}:`)) return;
	if (target.startsWith(`${Schemas.command}:`)) {
		const command = parseCommandLink(target);
		if (command) await commandService.executeCommand(command.id, ...command.args);
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
	if (openerService) await openerService.openExternal(target);
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

function parseCommandLink(target: string): { readonly id: string; readonly args: readonly unknown[] } | undefined {
	const match = /^command:(?:\/\/\/)?([^/?#]+)(?:\?([^#]*))?$/i.exec(target);
	if (!match) return undefined;
	let id: string;
	try { id = decodeURIComponent(match[1]!); }
	catch { return undefined; }
	if (!id) return undefined;
	if (!match[2]) return { id, args: [] };
	try {
		const args: unknown = JSON.parse(decodeURIComponent(match[2]));
		return Array.isArray(args) ? { id, args } : undefined;
	} catch {
		return undefined;
	}
}

function formatNumber(value: number): string { return new Intl.NumberFormat("en-US").format(value); }
