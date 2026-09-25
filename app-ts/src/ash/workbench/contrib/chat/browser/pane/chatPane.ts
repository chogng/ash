import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { ICommandService } from "../../../../../platform/commands/common/commands.js";
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../../../platform/contextview/browser/contextView.js";
import type { IChatService } from "../../../../services/chat/common/chatService.js";
import type { IActiveSessionThread, IUntitledChatSession, SessionId, ThreadId } from "../../../../../sessions/services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../../../../sessions/services/sessions/common/sessionsManagement.js";
import type { ChatInputDelegate } from "../input/chatInput.js";
import type { SkillReference } from "../../../../../platform/skills/common/skillApi.js";
import { ChatInputPart } from "../input/chatInputPart.js";
import type { ChatTurnErrorAction } from "../list/chatListItems.js";
import { ChatListWidget } from "../list/chatListWidget.js";
import { ChatPaneModel, type ChatPaneSelection } from "./chatPaneModel.js";
import { h } from "../../../../../base/browser/dom.js";
import type { ChatContextAttachment } from "../../../../services/chat/common/chatContextService.js";
import type { IChatContextPickService } from "../../../../services/chat/common/chatContextService.js";
import type { IQuickInputService } from "../../../../../platform/quickinput/common/quickInput.js";
import type { IOpenerService } from "../../../../../platform/opener/common/openerService.js";
import type { IEditorService } from "../../../../services/editor/common/editorService.js";
import { URI } from "../../../../../base/common/uri.js";
import { Schemas } from "../../../../../base/common/network.js";
import { ASH_REMOTE_SCHEME, createSshRemoteWorkspaceUri, getRemoteWorkspacePath } from '../../../../../platform/remote/common/remote.js';
import { OPEN_CHAT_SETTINGS_COMMAND_ID } from "../../common/chat.js";

/** Owns the content and interaction state for one local or durable Chat tab. */
export class ChatPane extends Disposable {
	readonly element: HTMLElement;
	readonly model: ChatPaneModel;
	private readonly listWidget: ChatListWidget;
	private readonly inputPart: ChatInputPart;
	private readonly goalElement: HTMLDivElement;
	private readonly sessionService: ISessionsManagementService;
	private submittedMessage = false;

	constructor(
		container: HTMLElement,
		panelId: string,
		chatService: IChatService,
		selection: ChatPaneSelection,
		sessionService: ISessionsManagementService,
		contextMenuService: IContextMenuService,
		contextViewService: IContextViewService,
		commandService: ICommandService,
		contextPickService: IChatContextPickService,
		quickInputService: IQuickInputService,
		openerService?: IOpenerService,
		editorService?: IEditorService,
		imageResourceLoader?: (resource: URI) => Promise<Blob>,
	) {
		super();
		const ownerDocument = container.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.id = panelId;
		this.element.className = "ash-chat";
		this.element.setAttribute("role", "tabpanel");
		this.element.hidden = true;
		container.append(this.element);
		this.sessionService = sessionService;
		this.model = this._register(new ChatPaneModel(chatService, selection, sessionService));
		this.goalElement = h(ownerDocument, "div");
		this.goalElement.className = "ash-chat-goal";
		this.goalElement.hidden = true;
		this.listWidget = this._register(new ChatListWidget(this.element, {
			imageResourceLoader,
			onDidRequestLink: target => {
				void openChatMarkdownLink(target, commandService, openerService, editorService).catch(error => console.error("Could not open Markdown link", error));
			},
			onDidRequestMemoryReference: reference => { void commandService.executeCommand('ash.memories.openReference', reference).catch(error => console.error('Could not open memory reference', error)); },
			onDidRequestErrorAction: (action) => void this.handleTurnErrorAction(action).catch(() => undefined),
		}));
		const inputDelegate: ChatInputDelegate = {
			send: (text, skills, contexts) => this.send(text, skills, contexts),
			executeCommand: (invocation) => invocation.argumentsText ? commandService.executeCommand(invocation.commandId, invocation.argumentsText) : commandService.executeCommand(invocation.commandId),
				executeServerCommand: (invocation) => invocation.name === "advisor" && !invocation.argumentsText.trim()
					? commandService.executeCommand(OPEN_CHAT_SETTINGS_COMMAND_ID)
					: this.model.executeServerCommand(invocation.name, invocation.argumentsText),
			interrupt: () => this.model.interrupt(),
			selectModel: (model) => this.model.selectModel(model),
			resolveInteraction: (response) => this.model.resolveInteraction(response),
		};
		this.inputPart = this._register(new ChatInputPart(this.element, inputDelegate, contextMenuService, contextViewService, contextPickService, quickInputService));
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

	selectThread(active: IActiveSessionThread): Promise<void> {
		if (active.session.sessionId !== this.sessionId) {
			throw new Error(`ChatPane cannot select a Thread from another Session: ${active.session.sessionId}`);
		}
		if (active.threadId !== this.threadId) this.submittedMessage = false;
		return this.model.selectThread(active);
	}

	selectUntitledSession(session: IUntitledChatSession): void {
		if (session.untitledSessionId !== this.untitledSessionId) {
			throw new Error(`ChatPane cannot select another Untitled Chat Session: ${session.untitledSessionId}`);
		}
		this.model.selectUntitledSession(session);
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

	acceptInput(value?: string): Promise<void> {
		return this.inputPart.acceptInput(value);
	}

	private async send(text: string, skills?: readonly SkillReference[], contexts: readonly ChatContextAttachment[] = []): Promise<void> {
		this.submittedMessage = true;
		this.updateConversationState();
		try {
			const resolvedContexts = await Promise.all(contexts.map(context => context.resolve()));
			await this.model.send(text, skills, resolvedContexts);
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
				this.sessionService.createUntitledSession();
				return;
			case "revise":
				this.inputPart.focus();
				return;
		}
	}

	private render(): void {
		this.syncIdentity();
		this.renderGoal();
		const items = this.model.items;
		this.updateConversationState(items.length > 0);
		this.listWidget.render(items);
		this.inputPart.render({
			phase: this.model.state,
			error: this.model.error,
			canInterrupt: this.model.canInterrupt,
			models: this.model.models,
			slashCommands: this.model.slashCommands,
			skillSelectors: this.model.skillSelectors,
			selectedModel: this.model.selectedModel,
			interaction: this.model.interaction,
		});
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
		return resource.authority === 'vscode-app' ? URI.parse(`file://${resource.path}`) : undefined;
	}
	if (resource.scheme === Schemas.vscodeRemote || resource.scheme === Schemas.vscodeRemoteResource) {
		const match = /^ssh-remote\+([A-Za-z0-9._-]+)$/u.exec(resource.authority);
		if (!match) return undefined;
		try { return createSshRemoteWorkspaceUri(match[1]!, decodeURIComponent(resource.path)); }
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
