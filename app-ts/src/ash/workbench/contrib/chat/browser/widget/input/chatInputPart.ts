import { addDisposableListener, h } from "../../../../../../base/browser/dom.js";
import { ButtonActionViewItem, type ActionViewItem } from "../../../../../../base/browser/ui/actionbar/actionViewItems.js";
import { status as announceStatus } from "../../../../../../base/browser/ui/aria/aria.js";
import { appendIcon } from "../../../../../../base/browser/ui/lxicons/lxicon.js";
import type { IAction } from "../../../../../../base/common/actions.js";
import { Separator } from "../../../../../../base/common/actions.js";
import type { Icon } from "../../../../../../base/common/icon.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../../../base/common/lifecycle.js";
import { Emitter } from '../../../../../../base/common/event.js';
import { Lxicon } from "../../../../../../base/common/lxicons.js";
import { localize, onDidChangeNls } from "../../../../../../nls.js";
import { WorkbenchToolBar } from "../../../../../../platform/actions/browser/toolbar.js";
import type { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import type { IDictationService, IDictationSession } from "../../../../../../platform/dictation/common/dictationService.js";
import type { IOpenAgentsWindowOptions } from '../../../../../../platform/native/common/nativeHost.js';
import type { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import type { IContextMenuService } from "../../../../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../../../../platform/contextview/browser/contextView.js";
import type { ModelCatalogEntry } from "../../../../../services/chat/common/chatService.js";
import type { ChatAgent } from '../../../../../services/chat/common/chatService.js';
import { ChatAttachmentModel } from '../../attachments/chatAttachmentModel.js';
import type { ModelReasoningEffort } from '../../../../../services/chat/common/modelCatalog.js';
import type { ChatContextAttachment } from "../../../../../services/chat/common/chatContextService.js";
import type { ModelRef } from "../../../../../services/chat/common/chatService.js";
import { DesktopSlashCommands, parseSlashCommandInput, SlashCommandCatalog } from "../../../common/slashCommands.js";
import { SkillSelectorCatalog } from "../../../common/skillSelectors.js";
import type { ChatInputDelegate, ChatInputState } from "./chatInput.js";
import { ChatInputEditors, type IChatInputEditor, type IChatInputEditorProvider } from "./chatInputEditorRegistry.js";
import { ChatInputPickerResponsiveLayout } from './chatInputPickerResponsiveLayout.js';
import { ModelPickerActionItem } from './modelPicker/modelPickerActionItem.js';
import { ModelPickerConfiguration } from './modelPicker/modelPickerConfiguration.js';
import { modelPickerEffortLabel } from './modelPicker/modelPickerModelConfig.js';
import { ModePickerActionItem, type ChatInputMode } from './modePickerActionItem.js';

type ChatInputToolbarPresentation = "mode" | "model" | "effort" | "mic" | "voice" | "send" | "interrupt";

interface ChatInputToolbarState {
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

const modeOptions: readonly { readonly id: ChatInputMode; readonly label: string; readonly icon?: Icon }[] = [
	{ id: "agent", label: "Agent", icon: Lxicon.unlimited },
	{ id: "plan", label: "Plan", icon: Lxicon.plan },
	{ id: "debug", label: "Debug", icon: Lxicon.debug },
	{ id: "multitask", label: "Multitask", icon: Lxicon.multitask },
	{ id: "ask", label: "Ask", icon: Lxicon.chat4 },
];

/** Owns the complete input region and all user-facing interactions for one Chat pane. */
export class ChatInputPart extends Disposable {
	readonly element: HTMLElement;
	private readonly inputChanges = this._register(new Emitter<void>());
	protected readonly onDidChangeInput = this.inputChanges.event;
	private readonly delegate: ChatInputDelegate;
	private readonly interactionListeners = this._register(new DisposableStore());
	private readonly attachmentListeners = this._register(new DisposableStore());
	protected readonly attachmentModel = this._register(new ChatAttachmentModel());
	private readonly status: HTMLDivElement;
	private readonly dictationPreview: HTMLDivElement;
	private readonly interaction: HTMLDivElement;
	private readonly attachmentList: HTMLDivElement;
	protected readonly inputContainer: HTMLFormElement;
	protected readonly input: IChatInputEditor;
	private readonly inputToolbar: WorkbenchToolBar;
	private readonly pickerResponsiveLayout: ChatInputPickerResponsiveLayout;
	private readonly slashCommands = new SlashCommandCatalog(DesktopSlashCommands, []);
	private readonly skills = new SkillSelectorCatalog();
	private state: ChatInputState = { mode: "agent", queuedMessages: 0, phase: "loading", canInterrupt: false, models: [], isAutomaticModel: false, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	private toolbarState: ChatInputToolbarState = { mode: "agent", canSubmit: false, hasInput: false, canInterrupt: false, inputKind: "message", models: [], isAutomaticModel: false, canSelectAgent: false };
	private serverSlashCommands: ChatInputState["slashCommands"] = [];
	private skillSelectors: ChatInputState["skillSelectors"] = [];
	private get mode(): ChatInputMode { return this.state.mode; }
	private pendingAgentSelection: { readonly agent: ChatAgent | undefined } | undefined;
	private dictationSession: IDictationSession | undefined;
	private dictationStarting = false;
	private dictationCancelStart = false;
	private visible = true;
	private draftRevision = 0;
	private submitting = false;

	constructor(container: HTMLElement, delegate: ChatInputDelegate, contextMenuService: IContextMenuService, contextViewService: IContextViewService, private readonly accessibleViewService: IAccessibleViewService, private readonly notifications: INotificationService, private readonly dictation?: IDictationService, editorProvider: Pick<IChatInputEditorProvider, 'create'> = ChatInputEditors, private readonly additionalActions: readonly IAction[] = []) {
		super();
		const ownerDocument = container.ownerDocument;
		this.delegate = delegate;
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
		this.attachmentList = h(ownerDocument, "div");
		this.attachmentList.className = "ash-chat-input-attachments";
		this.attachmentList.setAttribute("aria-label", "Attached context");
		const editorHost = h(ownerDocument, "div");
		editorHost.className = "ash-chat-input-editor-host";
		this.input = this._register(editorProvider.create({
			container: editorHost,
			placeholder: "Ask Ash",
			ariaLabel: "Chat message",
			slashCommands: this.slashCommands,
			skills: this.skills,
		}));
		this.inputToolbar = this._register(new WorkbenchToolBar(this.inputContainer, contextMenuService, {
			ariaLabel: "Chat input actions",
			actionViewItemProvider: action => this.createToolbarViewItem(action, contextViewService),
		}));
		this.inputToolbar.element.classList.add("ash-chat-input-toolbars");
		this.pickerResponsiveLayout = this._register(new ChatInputPickerResponsiveLayout(this.inputToolbar.element));
		this.inputContainer.append(this.attachmentList, editorHost, this.inputToolbar.element);
		this.element.append(this.status, this.dictationPreview, this.interaction, this.inputContainer);
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
			this.draftRevision++;
			this.inputChanges.fire();
			this.status.textContent = this.statusText(this.state);
			this.renderToolbar();
		}));
		this._register(this.input.onDidSubmit(() => this.inputContainer.requestSubmit()));
		this._register(this.attachmentModel.onDidChange(() => {
			this.draftRevision++;
			this.renderAttachments();
			this.renderToolbar();
			this.inputChanges.fire();
		}));
		this.renderToolbarActions();
		this.renderAttachments();
		this._register(onDidChangeNls(() => {
			this.renderToolbarActions();
			this.renderAttachments();
		}));
		this._register(toDisposable(() => this.element.remove()));
		this._register(toDisposable(() => { void this.stopDictation(); }));
	}

	private async submit(value: string, contexts: readonly ChatContextAttachment[], operation: Promise<void>): Promise<void> {
		this.input.value = "";
		this.renderToolbar();
		try {
			await operation;
			for (const context of contexts) {
				if (this.attachmentModel.attachments.includes(context)) this.attachmentModel.delete(context.id);
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
		this.attachmentModel.addContext(attachment);
	}

	async captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void } | undefined> {
		const text = this.input.value;
		const mode = this.mode;
		const attachments = this.attachmentModel.attachments;
		if (!text && attachments.length === 0) return undefined;
		const revision = this.draftRevision;
		const contexts = await Promise.all(attachments.map(async attachment => ({
			id: attachment.id,
			kind: attachment.kind,
			name: attachment.name,
			content: (await attachment.resolve()).content,
		})));
		if (this.draftRevision !== revision || this.mode !== mode) throw new Error(localize('chat.draftChangedDuringHandoff', 'The draft changed while opening Agents Window. Try again.'));
		return {
			draft: { mode, text, contexts },
			clear: () => {
				if (this.draftRevision !== revision || this.mode !== mode) return;
				this.input.value = '';
				this.attachmentModel.clear();
				this.draftRevision++;
				this.renderAttachments();
				this.renderToolbar();
				this.inputChanges.fire();
			},
		};
	}

	restoreDraft(draft: NonNullable<IOpenAgentsWindowOptions['draft']>): void {
		if (this.input.value || this.attachmentModel.size > 0) throw new Error(localize('chat.draftHandoffConflict', 'The Agents Window already has an unsent draft in this chat.'));
		this.delegate.selectMode(draft.mode);
		this.input.value = draft.text;
		for (const context of draft.contexts) {
			this.attachmentModel.addContext({
				id: context.id,
				kind: context.kind,
				name: context.name,
				resolve: async () => context.kind === 'image' ? { name: context.name, content: context.content, kind: 'image' } : { name: context.name, content: context.content },
			});
		}
		this.draftRevision++;
		this.renderAttachments();
		this.renderToolbar();
		this.inputChanges.fire();
	}

	async acceptInput(value?: string): Promise<void> {
		if (this.submitting || this.state.phase === 'loading' || this.state.phase === 'submitting') return;
		if (value !== undefined) this.input.value = value;
		if (!this.input.value.trim() && this.attachmentModel.size === 0) return;
		this.submitting = true;
		this.renderToolbar();
		try {
			if (this.dictationSession || this.dictationStarting) await this.stopDictation();
			const inputValue = this.input.value;
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
			const contexts = this.attachmentModel.attachments;
			await this.submit(inputValue, contexts, this.delegate.send(inputValue, this.mode, skills.length > 0 ? skills : undefined, contexts));
		} finally {
			this.submitting = false;
			this.renderToolbar();
			this.inputChanges.fire();
		}
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
		this.visible = visible;
		if (visible) this.input.layout();
		if (!visible && (this.dictationSession || this.dictationStarting)) void this.stopDictation();
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
		const canSubmitIntent = input.kind === "message" ? input.text.trim().length > 0 || this.attachmentModel.size > 0 : this.input.value.trim().length > 0;
		const state: ChatInputToolbarState = {
			mode: this.mode,
			canSubmit: canSubmitIntent && !this.submitting && (this.state.phase === 'ready' || this.state.phase === 'error'),
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
		this.toolbarState = state;
		this.renderToolbarActions();
	}

	private renderToolbarActions(): void {
		const mode = modeOptions.find(option => option.id === this.mode) ?? modeOptions[0]!;
		const modeLabel = this.mode === 'agent' ? this.state.selectedAgent?.name ?? this.state.agentName ?? mode.label : mode.label;
		const modeTooltip = this.mode === 'agent' && modeLabel !== mode.label
			? localize('chat.agentPicker.mode', 'Agent: {0}', modeLabel)
			: localize('chat.modePicker.mode', 'Mode: {0}', modeLabel);
		const modeAction = this.toolbarState.inputKind === "command"
			? new ChatInputAction("ash.chat.input.command", "Command", "Slash command", Lxicon.start, false, "mode", () => {})
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
						agentOptions.push(new ChatInputAction('ash.chat.input.agent.default', label, label, Lxicon.unlimited, true, 'mode', () => { this.pendingAgentSelection = { agent: undefined }; }, !this.state.selectedAgent));
					} else if (this.state.agentName) {
						agentOptions.push(new ChatInputAction('ash.chat.input.agent.current', this.state.agentName, this.state.agentName, Lxicon.unlimited, false, 'mode', () => {}, true));
					}
					agentOptions.push(...agents.map(agent => new ChatInputAction(
						`ash.chat.input.agent.${agent.sourceId}.${agent.name}`,
						agent.name,
						agent.description,
						undefined,
						true,
						'mode',
						() => { this.pendingAgentSelection = { agent }; },
						this.state.selectedAgent?.name === agent.name && this.state.selectedAgent.sourceId === agent.sourceId,
					)));
					return agentOptions.length > 0 ? [...options, new Separator(), ...agentOptions] : options;
				},
			);
		const selectedModel = this.toolbarState.models.find(entry => sameModel(entry.model, this.toolbarState.selectedModel));
		const selectedEffortLabel = modelPickerEffortLabel(this.toolbarState.selectedReasoningEffort ?? selectedModel?.modelReasoningEffort);
		const modelAction = new ChatInputAction(
			"ash.chat.input.model",
			this.toolbarState.isAutomaticModel ? localize('chat.modelPicker.auto', 'Auto') : selectedModel?.displayName ?? "Model",
			this.toolbarState.isAutomaticModel ? localize('chat.modelPicker.auto', 'Auto') : selectedModel ? `Model: ${selectedModel.displayName}` : "Select model",
			undefined,
			true,
			"model",
			() => {},
		);
		const effortAction = !this.toolbarState.isAutomaticModel && selectedModel?.supportedReasoningEfforts?.length
			? new ChatInputAction(
				'ash.chat.input.effort',
				selectedEffortLabel,
				localize('chat.modelPicker.effortAriaLabel', 'Thinking Effort: {0}', selectedEffortLabel),
				undefined,
				true,
				'effort',
				() => {},
			)
			: undefined;
		const micAction = new ChatInputAction(
			"ash.chat.input.mic",
			localize('chat.input.dictate', 'Dictate message'),
			this.dictationSession ? localize('chat.input.dictationStop', 'Stop dictation') : this.dictation ? localize('chat.input.dictate', 'Dictate message') : localize('chat.input.dictationUnavailable', 'Dictation is unavailable'),
			Lxicon.mic,
			!!this.dictation && !this.dictationStarting,
			"mic",
			() => { void this.toggleDictation(); },
			!!this.dictationSession,
		);
		let sendAction: ChatInputAction;
		if (this.toolbarState.hasInput) {
			const tooltip = this.toolbarState.inputKind === "command" ? "Run command" : "Send message";
			sendAction = new ChatInputAction("ash.chat.input.send", "Send", tooltip, Lxicon.arrowUp, this.toolbarState.canSubmit, "send", () => this.inputContainer.requestSubmit());
		} else {
			sendAction = new ChatInputAction("ash.chat.input.voice", localize('chat.input.voice', 'Voice conversation'), localize('chat.input.voiceUnavailable', 'Voice conversation is unavailable'), Lxicon.voiceMode, false, "voice", () => {});
		}
		const trailingActions = this.toolbarState.canInterrupt
			? [
				sendAction,
				new ChatInputAction("ash.chat.input.interrupt", "Stop", "Stop response", Lxicon.close, true, "interrupt", () => void this.delegate.interrupt()),
			]
			: [sendAction];
		const inputActions = this.toolbarState.inputKind === "command" ? [modeAction] : [...this.additionalActions, modeAction, modelAction, ...(effortAction ? [effortAction] : []), micAction];
		this.inputToolbar.setActions([...inputActions, ...trailingActions]);
		this.pickerResponsiveLayout.layout();
	}

	private async toggleDictation(): Promise<void> {
		if (this.dictationSession) {
			await this.stopDictation();
			return;
		}
		if (!this.dictation || this.dictationStarting) return;
		this.dictationStarting = true;
		this.dictationCancelStart = false;
		this.status.textContent = this.statusText(this.state);
		this.renderToolbarActions();
		let ended = false;
		try {
			const session = await this.dictation.start((text, isFinal) => {
				if (this.isDisposed || !this.visible) return;
				if (!isFinal) {
					this.dictationPreview.textContent = text;
					this.dictationPreview.hidden = !text;
					return;
				}
				this.dictationPreview.textContent = '';
				this.dictationPreview.hidden = true;
				if (!text) return;
				const existing = this.input.value;
				const separator = /[A-Za-z0-9]$/u.test(existing) && /^[A-Za-z0-9]/u.test(text) ? ' ' : '';
				this.input.value = `${existing}${separator}${text}`;
				this.input.focus();
				announceStatus(localize('chat.input.dictationInserted', 'Dictation added to message'));
			}, error => {
				ended = true;
				this.dictationSession = undefined;
				this.dictationPreview.textContent = '';
				this.dictationPreview.hidden = true;
				if (this.isDisposed) return;
				if (error) this.notifications.error(localize('chat.input.dictationFailed', 'Dictation failed: {0}', error));
				this.status.textContent = this.statusText(this.state);
				this.renderToolbarActions();
			});
			if (this.isDisposed || !this.visible || ended || this.dictationCancelStart) {
				await session.stop();
				return;
			}
			this.dictationSession = session;
		} catch (error) {
			if (!this.isDisposed) this.notifications.error(localize('chat.input.dictationFailed', 'Dictation failed: {0}', String(error)));
		} finally {
			this.dictationStarting = false;
			if (!this.isDisposed) {
				this.status.textContent = this.statusText(this.state);
				this.renderToolbarActions();
			}
		}
	}

	private async stopDictation(): Promise<void> {
		this.dictationCancelStart = true;
		const session = this.dictationSession;
		if (!session) return;
		this.dictationSession = undefined;
		if (!this.isDisposed) this.renderToolbarActions();
		try {
			await session.stop();
		} catch (error) {
			if (!this.isDisposed) this.notifications.error(localize('chat.input.dictationFailed', 'Dictation failed: {0}', String(error)));
		}
	}

	private renderAttachments(): void {
		this.attachmentListeners.clear();
		const children: HTMLElement[] = [];
		for (const attachment of this.attachmentModel.attachments) {
			const item = h(this.element.ownerDocument, "div");
			item.className = "ash-chat-input-attachment-item";
			const label = h(this.element.ownerDocument, "span");
			label.className = "ash-chat-input-attachment-label";
			label.textContent = attachment.name;
			const remove = h(this.element.ownerDocument, "button");
			remove.type = "button";
			remove.className = "ash-chat-input-attachment-remove";
			remove.setAttribute('aria-label', localize('chat.attach.remove', 'Remove {0}', attachment.name));
			appendIcon(Lxicon.close, remove);
			this.attachmentListeners.add(addDisposableListener(remove, "click", () => {
				this.attachmentModel.delete(attachment.id);
			}));
			item.append(label, remove);
			children.push(item);
		}
		this.attachmentList.replaceChildren(...children);
		const isEmpty = children.length === 0;
		this.attachmentList.classList.toggle('empty', isEmpty);
		this.attachmentList.hidden = isEmpty;
	}

	private createToolbarViewItem(action: IAction, contextViewService: IContextViewService): ActionViewItem | undefined {
		if (!(action instanceof ChatInputAction)) return undefined;
		if (action.presentation === 'model') {
			return new ModelPickerActionItem(action, {
				getModels: () => this.state.models,
				getSelectedModel: () => this.state.selectedModel,
				isAutomaticModel: () => this.state.isAutomaticModel,
				getModelsError: () => this.state.modelsError,
				selectModel: model => this.delegate.selectModel(model),
				selectAutomaticModel: () => this.delegate.selectAutomaticModel(),
				openSettings: () => this.delegate.openModelSettings(),
			}, contextViewService);
		}
		if (action.presentation === 'effort') {
			const entry = this.state.models.find(model => sameModel(model.model, this.state.selectedModel))!;
			return new ModelPickerConfiguration(action, entry, this.state.selectedReasoningEffort, async effort => {
				await this.delegate.selectReasoningEffort(effort);
				// Updating the effort replaces the toolbar action, so return focus to its new button.
				this.inputToolbar.element.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.effort'] button")?.focus();
			}, contextViewService, this.accessibleViewService);
		}
		if (action instanceof SelectorAction) {
			return new ModePickerActionItem(action, contextViewService, this.mode, () => {
				const selected = this.pendingAgentSelection;
				this.pendingAgentSelection = undefined;
				if (selected) {
					const changed = selected.agent?.name !== this.state.selectedAgent?.name || selected.agent?.sourceId !== this.state.selectedAgent?.sourceId;
					this.delegate.selectAgent(selected.agent);
					if (changed) return;
				}
				this.renderToolbarActions();
			});
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
		if (this.dictationSession || this.dictationStarting) return localize('chat.input.dictationListening', 'Listening…');
		switch (state.phase) {
			case "loading":
				return "Loading chat...";
			case "submitting":
				return "Working...";
			case "error":
				return "Chat is unavailable.";
			case "ready":
				if (state.queuedMessages > 0) return localize('chat.input.queuedMessages', '{0} messages queued', state.queuedMessages);
				if (state.activeMode && state.activeMode !== state.mode) return localize('chat.input.modeChangeQueued', 'Working in {0}. The next message will be queued in {1} mode.', state.activeMode, state.mode);
				return state.canInterrupt ? "Ash is working..." : "";
		}
	}
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
	readonly actions: readonly IAction[] | (() => Promise<readonly IAction[]>);

	constructor(id: string, label: string, tooltip: string, icon: Icon | undefined, presentation: "mode" | "model", actions: readonly IAction[] | (() => Promise<readonly IAction[]>), enabled = true) {
		super(id, label, tooltip, icon, enabled, presentation, () => {});
		this.actions = actions;
	}
}

function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
	return left === right || (left !== undefined && right !== undefined && left.provider === right.provider && left.model === right.model);
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
