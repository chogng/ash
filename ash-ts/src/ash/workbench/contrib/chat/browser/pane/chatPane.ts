import { Disposable, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { ICommandService } from "../../../../../platform/commands/common/commands.js";
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../../../platform/contextview/browser/contextView.js";
import type { IChatService } from "../../../../services/chat/common/chatService.js";
import type { IActiveSessionThread, IUntitledChatSession, SessionId, ThreadId } from "../../../../../sessions/services/sessions/common/session.js";
import type { ISessionsManagementService } from "../../../../../sessions/services/sessions/common/sessionsManagementService.js";
import type { ChatInputDelegate } from "../input/chatInput.js";
import type { SkillReference } from "../../../../../platform/skills/common/skillApi.js";
import { ChatInputPart } from "../input/chatInputPart.js";
import type { ChatTurnErrorAction } from "../list/chatListItems.js";
import { ChatListWidget } from "../list/chatListWidget.js";
import { ChatPaneModel, type ChatPaneSelection } from "./chatPaneModel.js";
import { h } from "../../../../../base/browser/dom.js";
import type { ChatContextAttachment, ResolvedChatAttachment, ResolvedChatContext, ResolvedInstructionAttachment } from "../../../../services/chat/common/chatContextService.js";
import type { IChatContextPickService } from "../../../../services/chat/common/chatContextService.js";
import type { IQuickInputService } from "../../../../../platform/quickinput/common/quickInput.js";

/** Owns the content and interaction state for one local or durable Chat tab. */
export class ChatPane extends Disposable {
	readonly element: HTMLElement;
	readonly model: ChatPaneModel;
	private readonly listWidget: ChatListWidget;
	private readonly inputPart: ChatInputPart;
	private readonly goalElement: HTMLDivElement;
	private readonly sessionService: ISessionsManagementService;
	private submittedMessage = false;

	constructor(container: HTMLElement, panelId: string, chatService: IChatService, selection: ChatPaneSelection, sessionService: ISessionsManagementService, contextMenuService: IContextMenuService, contextViewService: IContextViewService, commandService: ICommandService, contextPickService: IChatContextPickService, quickInputService: IQuickInputService) {
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
			onDidRequestMemoryReference: reference => { void commandService.executeCommand('ash.memories.openReference', reference).catch(error => console.error('Could not open memory reference', error)); },
			onDidRequestErrorAction: (action) => void this.handleTurnErrorAction(action).catch(() => undefined),
		}));
		const inputDelegate: ChatInputDelegate = {
			send: (text, skills, contexts) => this.send(text, skills, contexts),
			executeCommand: (invocation) => commandService.executeCommand(invocation.commandId, invocation.argumentsText),
			executeServerCommand: (invocation) => this.model.executeServerCommand(invocation.name, invocation.argumentsText),
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

	addContext(attachment: ChatContextAttachment<ResolvedChatAttachment>): void {
		this.inputPart.addContext(attachment);
	}

	acceptInput(value?: string): Promise<void> {
		return this.inputPart.acceptInput(value);
	}

	private async send(text: string, skills?: readonly SkillReference[], contexts: readonly ChatContextAttachment<ResolvedChatAttachment>[] = []): Promise<void> {
		this.submittedMessage = true;
		this.updateConversationState();
		try {
			const resolved = await Promise.all(contexts.map(context => context.resolve()));
			const instructions = resolved.filter((item): item is ResolvedInstructionAttachment => 'type' in item && item.type === 'instruction').map(item => item.reference);
			const contextItems = resolved.filter((item): item is ResolvedChatContext => !('type' in item));
			await this.model.send(text, skills, contextItems, instructions);
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

function formatNumber(value: number): string { return new Intl.NumberFormat("en-US").format(value); }
