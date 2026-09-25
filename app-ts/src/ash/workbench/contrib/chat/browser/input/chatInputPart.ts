import "./chatInputPart.css";
import { addDisposableListener, stopEvent, h } from "../../../../../base/browser/dom.js";
import { ButtonActionViewItem, type ActionViewItem } from "../../../../../base/browser/ui/actionbar/actionViewItems.js";
import { AnchorPosition, ContextView, ContextViewFocusRestore } from "../../../../../base/browser/ui/contextview/contextview.js";
import { DropdownMenuActionViewItem } from "../../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js";
import { appendIcon } from "../../../../../base/browser/ui/lxicons/lxicon.js";
import { Menu } from "../../../../../base/browser/ui/menu/menu.js";
import type { IAction } from "../../../../../base/common/actions.js";
import type { Icon } from "../../../../../base/common/icon.js";
import { Disposable, MutableDisposable, DisposableStore, toDisposable } from "../../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../../base/common/lxicons.js";
import { WorkbenchToolBar } from "../../../../../platform/actions/browser/toolbar.js";
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../../../platform/contextview/browser/contextView.js";
import type { IQuickInputService } from "../../../../../platform/quickinput/common/quickInput.js";
import type { ModelCatalogEntry } from "../../../../services/chat/common/chatService.js";
import type { ChatContextAttachment, IChatContextPickService } from "../../../../services/chat/common/chatContextService.js";
import type { ModelRef } from "../../../../../sessions/services/sessions/common/session.js";
import { DesktopSlashCommands, parseSlashCommandInput, SlashCommandCatalog } from "../../common/slashCommands.js";
import { SkillSelectorCatalog } from "../../common/skillSelectors.js";
import type { ChatInputDelegate, ChatInputState } from "./chatInput.js";
import { ChatInputEditors, type IChatInputEditor } from "./chatInputEditorRegistry.js";

type ChatInputMode = "agent" | "plan" | "debug" | "multitask" | "ask";
type ChatInputToolbarPresentation = "mode" | "model" | "attachment" | "send" | "interrupt";

interface ChatInputToolbarState {
	readonly canSubmit: boolean;
	readonly canInterrupt: boolean;
	readonly inputKind: "message" | "command";
	readonly models: readonly ModelCatalogEntry[];
	readonly selectedModel?: ModelRef;
}

const modeOptions: readonly { readonly id: ChatInputMode; readonly label: string }[] = [
	{ id: "agent", label: "Agent" },
	{ id: "plan", label: "Plan" },
	{ id: "debug", label: "Debug" },
	{ id: "multitask", label: "Multitask" },
	{ id: "ask", label: "Ask" },
];

/** Owns the complete input region and all user-facing interactions for one Chat pane. */
export class ChatInputPart extends Disposable {
	readonly element: HTMLElement;
	private readonly delegate: ChatInputDelegate;
	private readonly interactionListeners = this._register(new DisposableStore());
	private readonly attachmentListeners = this._register(new DisposableStore());
	private readonly attachments = new Map<string, ChatContextAttachment>();
	private readonly status: HTMLDivElement;
	private readonly interaction: HTMLDivElement;
	private readonly attachmentList: HTMLDivElement;
	private readonly inputContainer: HTMLFormElement;
	private readonly input: IChatInputEditor;
	private readonly inputToolbar: WorkbenchToolBar;
	private readonly slashCommands = new SlashCommandCatalog(DesktopSlashCommands, []);
	private readonly skills = new SkillSelectorCatalog();
	private state: ChatInputState = { phase: "loading", canInterrupt: false, models: [], slashCommands: [], skillSelectors: [] };
	private toolbarState: ChatInputToolbarState = { canSubmit: false, canInterrupt: false, inputKind: "message", models: [] };
	private serverSlashCommands: ChatInputState["slashCommands"] = [];
	private skillSelectors: ChatInputState["skillSelectors"] = [];
	private mode: ChatInputMode = "agent";

	constructor(container: HTMLElement, delegate: ChatInputDelegate, contextMenuService: IContextMenuService, contextViewService: IContextViewService, private readonly contextPickService: IChatContextPickService, private readonly quickInputService: IQuickInputService) {
		super();
		const ownerDocument = container.ownerDocument;
		this.delegate = delegate;
		this.element = h(ownerDocument, "div");
		this.element.className = "ash-chat-input-part";
		container.append(this.element);
		this.status = h(ownerDocument, "div");
		this.status.className = "ash-chat-status";
		this.status.setAttribute("role", "status");
		this.interaction = h(ownerDocument, "div");
		this.interaction.className = "ash-chat-interaction";
		this.interaction.setAttribute("aria-live", "polite");
		this.inputContainer = h(ownerDocument, "form");
		this.inputContainer.className = "ash-chat-input-container";
		this.attachmentList = h(ownerDocument, "div");
		this.attachmentList.className = "ash-chat-input-attachments";
		this.attachmentList.setAttribute("aria-label", "Attached context");
		const editorHost = h(ownerDocument, "div");
		editorHost.className = "ash-chat-input-editor-host";
		this.input = this._register(ChatInputEditors.create({
			container: editorHost,
			placeholder: "Ask Ash",
			ariaLabel: "Chat message",
			slashCommands: this.slashCommands,
			skills: this.skills,
		}));
		this.inputToolbar = this._register(new WorkbenchToolBar(this.inputContainer, contextMenuService, {
			ariaLabel: "Chat input actions",
			actionViewItemProvider: action => this.createToolbarViewItem(action, contextMenuService, contextViewService),
		}));
		this.inputToolbar.element.classList.add("ash-chat-input-toolbars");
		this.inputContainer.append(this.attachmentList, editorHost, this.inputToolbar.element);
		this.element.append(this.status, this.interaction, this.inputContainer);
		this._register(addDisposableListener(this.inputContainer, "focusin", () => this.inputContainer.classList.add("focused")));
		this._register(addDisposableListener(this.inputContainer, "focusout", event => {
			if (this.inputContainer.contains(event.relatedTarget as Node | null)) return;
			this.inputContainer.classList.remove("focused");
		}));
		this._register(addDisposableListener(this.inputContainer, "submit", (event) => {
			event.preventDefault();
			void this.acceptInput().catch(() => undefined);
		}));
		this._register(this.input.onDidChange(() => {
			this.status.textContent = this.statusText(this.state);
			this.renderToolbar();
		}));
		this._register(this.input.onDidSubmit(() => this.inputContainer.requestSubmit()));
		this.renderToolbarActions();
		this.renderAttachments();
		this._register(toDisposable(() => this.element.remove()));
	}

	private async submit(value: string, contexts: readonly ChatContextAttachment[], operation: Promise<void>): Promise<void> {
		this.input.value = "";
		this.renderToolbar();
		try {
			await operation;
			for (const context of contexts) {
				const key = attachmentKey(context);
				if (this.attachments.get(key) === context) this.attachments.delete(key);
			}
			this.renderAttachments();
		} catch (error) {
			if (!this.input.value) {
				this.input.value = value;
				this.renderToolbar();
			}
			throw error;
		}
	}

	focus(): void {
		this.input.focus();
	}

	addContext(attachment: ChatContextAttachment): void {
		if (!attachment.id.trim() || !attachment.kind.trim() || !attachment.name.trim()) throw new TypeError("Chat context attachment requires an ID, kind, and name");
		this.attachments.set(attachmentKey(attachment), attachment);
		this.renderAttachments();
	}

	async acceptInput(value?: string): Promise<void> {
		if (value !== undefined) this.input.value = value;
		const inputValue = this.input.value;
		if (!inputValue.trim()) return;
		const input = parseSlashCommandInput(inputValue, this.slashCommands);
		if (input.kind === "command" && input.binding.origin === "local") {
			await this.submit(inputValue, [], this.delegate.executeCommand({ commandId: input.binding.actionId, argumentsText: input.argumentsText }));
			return;
		}
		if (input.kind === "command" && input.binding.origin === "server") {
			await this.submit(inputValue, [], this.delegate.executeServerCommand({ name: input.command.name, argumentsText: input.argumentsText }));
			return;
		}
		const skills = this.skills.referencesIn(inputValue);
		const contexts = [...this.attachments.values()];
		await this.submit(inputValue, contexts, this.delegate.send(inputValue, skills.length > 0 ? skills : undefined, contexts));
	}

	openModelSelector(): void {
		const button = this.inputToolbar.element.querySelector<HTMLButtonElement>(".ash-chat-input-model-action");
		if (!button || button.disabled || button.classList.contains("disabled")) {
			this.focus();
			return;
		}
		button.focus();
		button.click();
	}

	setVisible(visible: boolean): void {
		if (visible) this.input.layout();
	}

	render(state: ChatInputState): void {
		if (this.serverSlashCommands !== state.slashCommands) {
			this.slashCommands.setServerCommands(state.slashCommands);
			this.serverSlashCommands = state.slashCommands;
		}
		if (this.skillSelectors !== state.skillSelectors) {
			this.skills.setSkills(state.skillSelectors);
			this.skillSelectors = state.skillSelectors;
		}
		this.state = state;
		this.status.textContent = this.statusText(state);
		this.renderInteraction(state);
		this.renderToolbar();
	}

	private renderToolbar(): void {
		const input = parseSlashCommandInput(this.input.value, this.slashCommands);
		const canSubmitIntent = input.kind === "message" ? input.text.trim().length > 0 : this.input.value.trim().length > 0;
		const state: ChatInputToolbarState = {
			canSubmit: canSubmitIntent && this.state.phase !== "submitting",
			canInterrupt: this.state.canInterrupt,
			inputKind: input.kind === "message" ? "message" : "command",
			models: this.state.models,
			selectedModel: this.state.selectedModel,
		};
		if (
			state.canSubmit === this.toolbarState.canSubmit &&
			state.canInterrupt === this.toolbarState.canInterrupt &&
			state.inputKind === this.toolbarState.inputKind &&
			state.models === this.toolbarState.models &&
			sameModel(state.selectedModel, this.toolbarState.selectedModel)
		) return;
		this.toolbarState = state;
		this.renderToolbarActions();
	}

	private renderToolbarActions(): void {
		const mode = modeOptions.find(option => option.id === this.mode) ?? modeOptions[0]!;
		const modeAction = this.toolbarState.inputKind === "command"
			? new ChatInputAction("ash.chat.input.command", "Command", "Slash command", Lxicon.start, false, "mode", () => {})
			: new SelectorAction(
				"ash.chat.input.mode",
				mode.label,
				`Mode: ${mode.label}`,
				Lxicon.unlimited,
				"mode",
				() => modeOptions.map(option => new ChatInputAction(
					`ash.chat.input.mode.${option.id}`,
					option.label,
					`Use ${option.label} mode`,
					undefined,
					true,
					"mode",
					() => {
						this.mode = option.id;
					},
					option.id === this.mode,
				)),
			);
		const selectedModel = this.toolbarState.models.find(entry => sameModel(entry.model, this.toolbarState.selectedModel));
		const modelAction = new SelectorAction(
			"ash.chat.input.model",
			selectedModel?.displayName ?? "Model",
			selectedModel ? `Model: ${selectedModel.displayName}` : "Select model",
			undefined,
			"model",
			this.toolbarState.models.map(entry => new ChatInputAction(
				`ash.chat.input.model.${entry.model.provider}.${entry.model.model}`,
				entry.displayName,
				`Use ${entry.displayName}`,
				undefined,
				true,
				"model",
				() => void this.delegate.selectModel(entry.model),
				sameModel(entry.model, this.toolbarState.selectedModel),
			)),
			this.toolbarState.models.length > 0,
		);
		const attachmentAction = new ChatInputAction(
			"ash.chat.input.attachment",
			"Attach",
			"Attach context",
			Lxicon.paperclip,
			true,
			"attachment",
			() => void this.pickContext(),
		);
		const sendAction = new ChatInputAction(
			"ash.chat.input.send",
			"Send",
			this.toolbarState.inputKind === "command" ? "Run command" : "Send message",
			Lxicon.arrowUp,
			this.toolbarState.canSubmit,
			"send",
			() => this.inputContainer.requestSubmit(),
		);
		const trailingActions = this.toolbarState.canInterrupt
			? [
				sendAction,
				new ChatInputAction("ash.chat.input.interrupt", "Stop", "Stop response", Lxicon.close, true, "interrupt", () => void this.delegate.interrupt()),
			]
			: [sendAction];
		const inputActions = this.toolbarState.inputKind === "command" ? [modeAction] : [modeAction, modelAction, attachmentAction];
		this.inputToolbar.setActions([...inputActions, ...trailingActions]);
	}

	private async pickContext(): Promise<void> {
		const attachment = await this.contextPickService.pickContext(this.quickInputService);
		if (!attachment) return;
		this.addContext(attachment);
		this.focus();
	}

	private renderAttachments(): void {
		this.attachmentListeners.clear();
		const children: HTMLElement[] = [];
		for (const attachment of this.attachments.values()) {
			const item = h(this.element.ownerDocument, "div");
			item.className = "ash-chat-input-attachment-item";
			const label = h(this.element.ownerDocument, "span");
			label.className = "ash-chat-input-attachment-label";
			label.textContent = attachment.name;
			const remove = h(this.element.ownerDocument, "button");
			remove.type = "button";
			remove.className = "ash-chat-input-attachment-remove";
			remove.setAttribute("aria-label", `Remove ${attachment.name}`);
			appendIcon(Lxicon.close, remove);
			this.attachmentListeners.add(addDisposableListener(remove, "click", () => {
				this.attachments.delete(attachmentKey(attachment));
				this.renderAttachments();
			}));
			item.append(label, remove);
			children.push(item);
		}
		this.attachmentList.replaceChildren(...children);
		this.attachmentList.hidden = children.length === 0;
	}

	private createToolbarViewItem(action: IAction, contextMenuService: IContextMenuService, contextViewService: IContextViewService): ActionViewItem | undefined {
		if (!(action instanceof ChatInputAction)) return undefined;
		if (action instanceof SelectorAction) {
			return action.presentation === "mode"
				? new ChatInputModeSelectorViewItem(action, contextViewService, () => this.renderToolbarActions())
				: new ChatInputSelectorViewItem(action, contextMenuService);
		}
		return new ChatInputButtonViewItem(action);
	}

	private renderInteraction(state: ChatInputState): void {
		this.interactionListeners.clear();
		this.interaction.replaceChildren();
		const interaction = state.interaction;
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
				const actions = h(this.element.ownerDocument, "div");
				actions.className = "ash-chat-interaction-actions";
				const decline = this.interactionButton("Decline");
				const approve = this.interactionButton("Approve once", true);
				actions.append(decline, approve);
				this.interaction.append(reason, actions);
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
					const answers: Record<string, { value: string }> = {};
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

	private questionSelect(options: readonly { readonly label: string }[]): HTMLSelectElement {
		const select = h(this.element.ownerDocument, "select");
		for (const option of options) {
			const element = h(this.element.ownerDocument, "option");
			element.value = option.label;
			element.textContent = option.label;
			select.append(element);
		}
		return select;
	}

	private statusText(state: ChatInputState): string {
		if (state.error) return state.error;
		switch (state.phase) {
			case "loading":
				return "Loading chat...";
			case "submitting":
				return "Working...";
			case "error":
				return "Chat is unavailable.";
			case "ready":
				return state.canInterrupt ? "Ash is working..." : "";
		}
	}
}

function attachmentKey(attachment: ChatContextAttachment): string {
	return `${attachment.kind}\0${attachment.id}`;
}

class ChatInputAction implements IAction {
	constructor(
		readonly id: string,
		readonly label: string,
		readonly tooltip: string,
		readonly icon: Icon | undefined,
		readonly enabled: boolean,
		readonly presentation: ChatInputToolbarPresentation,
		readonly callback: () => void,
		readonly checked: boolean | undefined = undefined,
	) {}

	run(): void {
		this.callback();
	}
}

class SelectorAction extends ChatInputAction {
	readonly actions: readonly IAction[] | (() => readonly IAction[]);

	constructor(id: string, label: string, tooltip: string, icon: Icon | undefined, presentation: "mode" | "model", actions: readonly IAction[] | (() => readonly IAction[]), enabled = true) {
		super(id, label, tooltip, icon, enabled, presentation, () => {});
		this.actions = actions;
	}
}

function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
	return left === right || (left !== undefined && right !== undefined && left.provider === right.provider && left.model === right.model);
}

class ChatInputSelectorViewItem extends DropdownMenuActionViewItem {
	private readonly presentation: "mode" | "model";

	constructor(action: SelectorAction, contextMenuService: IContextMenuService) {
		super(action, action.actions, contextMenuService);
		this.presentation = action.presentation as "mode" | "model";
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add("ash-chat-input-selector", `ash-chat-input-${this.presentation}-selector`);
		container.classList.toggle("disabled", !this.action.enabled);
		const button = container.querySelector<HTMLButtonElement>(":scope > .ash-button");
		button?.classList.add("ash-chat-input-action", `ash-chat-input-${this.presentation}-action`);
		button?.classList.toggle("disabled", !this.action.enabled);
	}
}

/** Chat-owned HTML popup presentation for the mode selector. */
class ChatInputModeSelectorViewItem extends ButtonActionViewItem {
	private readonly selectorAction: SelectorAction;
	private readonly contextViewService: IContextViewService;
	private readonly onDidSelect: () => void;
	private readonly menu = this._register(new MutableDisposable<Menu>());
	private contextView: ContextView | undefined;
	private visible = false;

	constructor(action: SelectorAction, contextViewService: IContextViewService, onDidSelect: () => void) {
		super(action);
		this.selectorAction = action;
		this.contextViewService = contextViewService;
		this.onDidSelect = onDidSelect;
	}

		override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add("ash-chat-input-selector", "ash-chat-input-mode-selector", "ash-dropdown-menu-action-view-item");
		container.classList.toggle("disabled", !this.action.enabled);
		const button = this.button.domNode;
		this.button.toggleClassName("ash-chat-input-action", true);
		this.button.toggleClassName("ash-chat-input-mode-action", true);
		this.button.toggleClassName("disabled", !this.action.enabled);
		button.querySelector(".ash-button-label")?.classList.add("ash-chat-input-mode-action-label");
		button.setAttribute("aria-haspopup", "menu");
		button.setAttribute("aria-expanded", "false");
		const indicator = h(container.ownerDocument, "span");
		indicator.className = "ash-dropdown-menu-indicator ash-chat-input-mode-indicator";
		appendIcon(Lxicon.chevronDown, indicator);
		button.append(indicator);
		this.contextView = this._register(new ContextView(this.contextViewService.container));
		this._register(addDisposableListener(button, "keydown", (event) => {
			if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
			stopEvent(event);
			this.show();
		}));
	}

	protected override runAction(): void {
		if (this.visible) {
			this.contextView?.hide();
			return;
		}
		this.show();
	}

	private show(): void {
		const contextView = this.contextView;
		if (!contextView || this.visible || !this.action.enabled) return;
		const actions = typeof this.selectorAction.actions === "function" ? this.selectorAction.actions() : this.selectorAction.actions;
		if (actions.length === 0) return;
		const menu = new Menu(contextView.element, {
			actions,
			contextViewContainer: this.contextViewService.container,
			layer: 20,
			onDidSelect: () => {
				contextView.hide();
				this.onDidSelect();
			},
		});
		menu.element.classList.add("ash-chat-input-mode-menu");
		this.menu.value = menu;
		const shown = contextView.show({
			anchor: this.button.domNode,
			content: menu.element,
			anchorPosition: AnchorPosition.Below,
			gap: 2,
			presentation: "menu",
			focusRestore: ContextViewFocusRestore.Previous,
			layer: 20,
			isTargetWithin: target => menu.contains(target),
			onHide: () => {
				this.visible = false;
				this.button.domNode.setAttribute("aria-expanded", "false");
				this.menu.clear();
			},
		});
		if (!shown) {
			this.menu.clear();
			return;
		}
		this.visible = true;
		this.button.domNode.setAttribute("aria-expanded", "true");
		menu.focusFirst();
	}
}

class ChatInputButtonViewItem extends ButtonActionViewItem {
	private readonly presentation: ChatInputToolbarPresentation;

	constructor(action: ChatInputAction) {
		super(action);
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
