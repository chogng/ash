import type { SkillReference } from '../../../../../../platform/agentHost/common/appServerApi.js';
import { ChatHistoryNavigator } from '../../../common/widget/chatWidgetHistoryService.js';
import type { MessageHistoryEntry } from '../../../../../../platform/messageHistory/common/messageHistory.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import type { ChatInputEditorSelection } from './chatInputEditorRegistry.js';
import '../media/chat.css';
import { ISpeechService, SpeechToTextState } from '../../../../speech/common/speechService.js';
import { DictationActionViewItem } from '../../speechToText/dictationActionViewItem.js';
import { DictationSession } from '../../speechToText/dictationSession.js';
import { IDictationOnboardingService } from '../../speechToText/dictationOnboarding.js';
import { addDisposableListener, h, stopEvent } from "../../../../../../base/browser/dom.js";
import { ActionViewItem, ButtonActionViewItem } from "../../../../../../base/browser/ui/actionbar/actionViewItems.js";
import type { IAction } from "../../../../../../base/common/actions.js";
import { Separator } from "../../../../../../base/common/actions.js";
import type { Icon } from "../../../../../../base/common/icon.js";
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from "../../../../../../base/common/lifecycle.js";
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
import { DefaultChatAttachmentWidget, ImageAttachmentWidget } from '../../attachments/chatAttachmentWidgets.js';
import { status as announceStatus } from '../../../../../../base/browser/ui/aria/aria.js';
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
import { approvalModeDefinition, approvalModeDefinitions } from '../../../../../../platform/sessions/common/approvalModes.js';
import { PermissionPickerActionItem } from './permissionPickerActionItem.js';
import { ModePickerActionItem, type ChatInputMode } from './modePickerActionItem.js';
import { ChatContextUsageWidget } from '../../widgetHosts/viewPane/chatContextUsageWidget.js';

type ChatInputToolbarPresentation = "mode" | "model" | "mic" | "voice" | "send" | "interrupt";

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

const modeOptions: readonly { readonly id: ChatInputMode; readonly label: string; readonly icon?: Icon; }[] = [
	{ id: "agent", label: "Agent", icon: Lxicon.unlimited },
	{ id: "plan", label: "Plan", icon: Lxicon.plan },
	{ id: "debug", label: "Debug", icon: Lxicon.debug },
	{ id: "multitask", label: "Multitask", icon: Lxicon.multitask },
	{ id: "ask", label: "Ask", icon: Lxicon.chat4 },
];

/** Picker composition is selected by the host; input state and operations keep one owner. */
export interface ChatInputPartOptions {
	readonly modePicker: 'visible' | 'hidden';
	readonly modelPickerPosition: 'leading' | 'trailing';
	readonly renderSecondaryToolbar?: boolean;
}

/** Input operations consumed by a Chat pane, independent of its product's composer layout. */
export interface IChatInputPart extends IDisposable {
	readonly element: HTMLElement;
	focus(): void;
	addContext(attachment: ChatContextAttachment): void;
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
	readonly element: HTMLElement;
	private readonly history: ChatHistoryNavigator<InputHistoryDraft>;
	private readonly historySearch = this._register(new MutableDisposable<DisposableStore>());
	private applyingHistory = false;
	private historyInputRevision = 0;
	private draftSkills: { readonly text: string; readonly references: readonly SkillReference[]; } | undefined;
	private readonly inputChanges = this._register(new Emitter<void>());
	protected readonly onDidChangeInput = this.inputChanges.event;
	private readonly delegate: ChatInputDelegate;
	private readonly interactionListeners = this._register(new DisposableStore());
	private renderedInteraction: ChatInputState['interaction'];
	private readonly attachmentWidgets = this._register(new DisposableMap<string, DefaultChatAttachmentWidget>());
	private readonly attachContext = this._register(new MutableDisposable<AttachContextAction>());
	protected readonly attachmentModel = this._register(new ChatAttachmentModel());
	private readonly status: HTMLDivElement;
	private readonly dictationPreview: HTMLDivElement;
	private readonly interaction: HTMLDivElement;
	private readonly attachmentList: HTMLDivElement;
	protected readonly inputContainer: HTMLFormElement;
	protected readonly input: IChatInputEditor;
	private readonly inputToolbar: WorkbenchToolBar;
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
	private readonly pickerResponsiveLayout: ChatInputPickerResponsiveLayout;
	private readonly slashCommands = new SlashCommandCatalog(DesktopSlashCommands, []);
	private readonly skills = new SkillSelectorCatalog();
	private state: ChatInputState = { mode: "agent", queuedMessages: 0, approvalMode: 'manual', phase: "loading", canInterrupt: false, models: [], isAutomaticModel: false, slashCommands: [], skillSelectors: [], canSelectAgent: false };
	private toolbarState: ChatInputToolbarState = { mode: "agent", canSubmit: false, hasInput: false, canInterrupt: false, inputKind: "message", models: [], isAutomaticModel: false, canSelectAgent: false };
	private serverSlashCommands: ChatInputState["slashCommands"] = [];
	private skillSelectors: ChatInputState["skillSelectors"] = [];
	private get mode(): ChatInputMode { return this.state.mode; }
	private pendingAgentSelection: { readonly agent: ChatAgent | undefined; } | undefined;
	private readonly dictationSession: DictationSession;
	private visible = true;
	private draftRevision = 0;
	private submitting = false;

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
		@ISpeechService private readonly speechToText: ISpeechService,
		@IDictationOnboardingService private readonly onboarding: IDictationOnboardingService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IMenuService menuService: IMenuService,
	) {
		super();
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
		this.attachmentList = h(ownerDocument, "div");
		this.attachmentList.className = "ash-chat-input-attachments";
		this.attachmentList.setAttribute('role', 'list');
		this.attachmentList.setAttribute('aria-label', localize('chat.context.attached', 'Attached context'));
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
			ariaLabel: localize('chat.input.actions', 'Chat input actions'),
			actionViewItemProvider: action => this.createToolbarViewItem(action, contextViewService),
		}));
		this.inputToolbar.element.classList.add("ash-chat-input-toolbars");
		this.inputToolbar.element.classList.toggle('model-picker-trailing', options.modelPickerPosition === 'trailing');
		this.pickerResponsiveLayout = this._register(new ChatInputPickerResponsiveLayout(this.inputToolbar.element));
		this.inputContainer.append(this.attachmentList, editorHost, this.inputToolbar.element);
		this.secondaryToolbarContainer = options.renderSecondaryToolbar === false
			? undefined
			: this.createSecondaryToolbar(contextMenuService, menuService);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 95, name: `chatAttachments-${type}-${createUuid()}`,
				getProvider: () => {
					const focused = this.element.ownerDocument.activeElement as HTMLElement | null;
					const footerFocused = focused && this.secondaryToolbarContainer?.contains(focused);
					if (!focused || (!footerFocused && !this.input.element.contains(focused) && !this.attachmentList.contains(focused) && !this.inputToolbar.element.querySelector('[data-action-id="ash.chat.input.attach"]')?.contains(focused))) { return undefined; }
					if (footerFocused && type === AccessibleViewType.View) { return undefined; }
					if (type === AccessibleViewType.View && this.attachmentModel.size === 0) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.SessionsChat, { type }, () => {
						const names = this.attachmentModel.attachments.map(attachment => attachment.name).join('\n');
						return type === AccessibleViewType.View ? names : localize('chat.context.help', 'Chat context\nUse Add context to search recent and workspace files, attach files or images, read an image from the clipboard, take a screenshot, select a session, issue or pull request, choose Files & Folders to include a directory, add open editors including unsaved text, or select another context source. Type to search, use arrow keys to choose, Enter to attach, Ctrl or Command+Enter to attach and keep searching, and Escape to cancel. Use Go back to return to the previous picker. Directory attachments include their path and file list. Session and GitHub attachments capture their content when selected. Terminal attaches selected text or recent output. Symbols attach their source range, including unsaved edits. Search Results attaches the completed search and its match locations. These attachments keep the content captured when selected; their source button returns to the terminal, code or Search view. Tools attaches an enabled tool or tool set. Choose Configure tools, use Enter to toggle a tool or set, then choose Apply to save for this chat. Escape discards changes. Selection applies to the next request and is retained after sending; remove its attachment to reset. Steering cannot change a running request’s selection. A tool reference’s source button opens Tools settings. Calls use the current tool catalog and execution permissions. Instructions selects from the authorized user and directory catalog; the backend loads the current instruction when sending. Its source button opens the instruction file. Browser screenshots ask you to choose a screen, window or tab and can be cancelled. GitHub pickers let you choose an account and repository, paste a link, enter a number or load more items. Use Tab to reach the source and Remove buttons on each attachment; Enter opens its source. Removing an attachment focuses the next attachment or returns to the message. Attachments can be sent without text and remain in the draft when sending fails.') + '\n' + localize('hooks.feedbackHelp', 'Hook blocks and failures appear in the conversation. Use Tab to reach a Hook summary and Enter or Space to expand its reason. Execution Trace shows status and duration; enable detailed recording to load commands and input/output on demand.') + '\n' + localize('chat.history.help', 'Chat input: Enter sends; Shift+Enter inserts a line. At the first or last input row, Arrow Up and Arrow Down recall earlier inputs. Press Ctrl+R to search all input history; Enter restores the selected text without sending it. Escape restores the original draft, cursor, attachments and Skill bindings. Input history belongs to the local Profile and stores text only.') + '\n' + (this.secondaryToolbarContainer ? localize('chat.input.secondaryHelp', 'Below the input, the approval mode button shows the current mode. Press Enter or Space to open its menu above the button, use arrow keys to choose a mode, and Escape to close the menu and return focus. Full access requires confirmation. The static context ring shows the estimated share of model capacity in use. Hover or focus it to read the percentage and token counts, or activate it to open the breakdown above the ring. Unknown capacity uses an empty ring and shows token counts without a percentage. Press Escape or activate Close to close the details and return to the ring. Loading, working and error status appears alongside extension status indicators. Use Tab to reach each toolbar, arrow keys to move between actions, and Enter or Space to activate an action.') : '') + '\n' + names;
					}, () => focused.isConnected ? focused.focus() : this.focus(), AccessibilityVerbositySettingId.Chat);
				},
			}));
		}

		this.dictationSession = this._register(instantiationService.createInstance(DictationSession, this.input, this.dictationPreview, () => this.visible, () => this.delegate.openModelSettings('dictation')));
		this._register(this.speechToText.onDidChangeState(() => { this.renderStatus(); this.renderToolbarActions(); }));
		this._register(this.dictationSession.onDidEnd(error => { if (error) { this.notifications.error(localize('chat.input.dictationFailed', 'Dictation failed: {0}', error)); } }));
		if (!this.secondaryToolbarContainer) this.element.append(this.status);
		this.element.append(this.dictationPreview, this.interaction, this.inputContainer);
		if (this.secondaryToolbarContainer) this.element.append(this.secondaryToolbarContainer);
		this._register(onboarding.registerHost({ container: this.element, focusTarget: this.element, isVisible: () => this.visible }));
		this._register(addDisposableListener(this.inputContainer, "focusin", event => {
			this.inputContainer.classList.add("focused");
			if (this.attachmentList.contains(event.target as Node) || this.input.element.contains(event.target as Node)) {
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
			this.draftRevision++;
			if (!this.applyingHistory) { this.history.reset(); this.historyInputRevision++; }
			this.inputChanges.fire();
			this.renderStatus();
			this.renderToolbar();
		}));
		this._register(addDisposableListener(this.input.element, "keydown", event => this.handleHistoryKey(event), true));
		this._register(this.input.onDidSubmit(() => this.inputContainer.requestSubmit()));
		this._register(this.attachmentModel.onDidChange(() => {
			this.draftRevision++;
			if (!this.applyingHistory) { this.history.reset(); this.historyInputRevision++; }
			this.renderAttachments();
			this.renderToolbar();
			this.inputChanges.fire();
		}));
		this.renderToolbarActions();
		this.renderAttachments();
		this._register(toDisposable(() => this.element.remove()));
		this._register(toDisposable(() => { void this.stopDictation(); }));
	}

	private captureHistoryDraft(): InputHistoryDraft {
		return { text: this.input.value, selection: this.input.getSelection(), attachments: this.attachmentModel.attachments, skills: this.draftSkills?.text === this.input.value ? this.draftSkills.references : this.skills.referencesIn(this.input.value) };
	}

	private applyHistoryDraft(draft: InputHistoryDraft): void {
		this.applyingHistory = true;
		try {
			this.input.value = draft.text;
			this.input.setSelection(draft.selection);
			const attachments = this.attachmentModel.attachments;
			if (attachments.length !== draft.attachments.length || attachments.some((attachment, index) => attachment !== draft.attachments[index])) {
				this.attachmentModel.clear();
				this.attachmentModel.addContext(...draft.attachments);
			}
			this.draftSkills = { text: draft.text, references: draft.skills };
		} finally {
			this.applyingHistory = false;
		}
	}

	private applyHistoryEntry(entry: MessageHistoryEntry): void {
		this.applyingHistory = true;
		try {
			this.input.value = entry.text;
			this.input.setSelection({ anchor: entry.text.length, active: entry.text.length });
			this.attachmentModel.clear();
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
		resources.add(picker.onDidAccept(item => {
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

	private async submit(value: string, contexts: readonly ChatContextAttachment[], operation: Promise<void>): Promise<void> {
		void this.history.record(value, parseSlashCommandInput(value, this.slashCommands).kind === 'command' ? 'command' : 'agent').catch(error => {
			if (!this.isDisposed) this.notifications.error(localize('chat.history.saveFailed', 'Could not save input history: {0}', String(error)));
		});
		this.input.value = "";
		this.renderToolbar();
		try {
			await operation;
			for (const context of contexts) {
				if (context.kind !== 'toolSelection' && this.attachmentModel.attachments.includes(context)) this.attachmentModel.delete(context.id);
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

	async captureDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
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
			...(attachment.resource ? { resource: attachment.resource.toString() } : {}),
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

	appendToDraft(text: string): void {
		const previous = this.input.value;
		this.input.value = previous ? `${previous}\n\n${text}` : text;
		this.renderToolbar();
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
				resource: context.resource ? URI.parse(context.resource) : undefined,
				resolve: async () => ({ name: context.name, content: context.content, ...(context.kind === 'image' || context.kind === 'instruction' || context.kind === 'toolSelection' ? { kind: context.kind } : {}) }),
			});
		}
		this.draftRevision++;
		this.renderAttachments();
		this.renderToolbar();
		this.inputChanges.fire();
	}

	async acceptInput(value?: string): Promise<void> {
		const intent = parseSlashCommandInput(value ?? this.input.value, this.slashCommands);
		// Local product settings must remain available while the model catalog is loading.
		const localCommand = intent.kind === 'command' && intent.binding.origin === 'local';
		if (this.submitting || this.state.phase === 'submitting' || (this.state.phase === 'loading' && !localCommand)) return;
		if (value !== undefined) this.input.value = value;
		if (!this.input.value.trim() && !this.attachmentModel.attachments.some(attachment => attachment.kind !== 'toolSelection')) return;
		this.submitting = true;
		this.renderToolbar();
		try {
			if (this.dictationSession.isActive) await this.stopDictation();
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
			if (!this.supportsImages() && this.attachmentModel.attachments.some(attachment => attachment.kind === 'image')) {
				this.notifications.error(localize('chat.image.unsupported', 'The selected model does not support images'));
				return;
			}
			const skills = this.draftSkills?.text === inputValue ? this.draftSkills.references : this.skills.referencesIn(inputValue);
			const contexts = this.attachmentModel.attachments;
			await this.submit(inputValue, contexts, this.delegate.send(inputValue, this.mode, skills.length > 0 ? skills : undefined, contexts));
		} finally {
			this.submitting = false;
			this.renderToolbar();
			this.inputChanges.fire();
		}
	}

	openModelSelector(): void {
		this.modelPickerActionItem.openModelPicker();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) {
			this.input.layout();
			this.contextUsageWidget?.update(this.state.contextUsage);
		}
		if (!visible) {
			this.contextUsageWidget?.hide();
			this.history.invalidatePending();
			this.historySearch.clear();
			this.permissionWidget?.hide();
			this.attachContext.clear();
			this.onboarding.hide(this.element);
			void this.dictationSession.cancel().catch(error => {
				if (!this.isDisposed) { this.notifications.error(localize('chat.input.dictationFailed', 'Dictation failed: {0}', String(error))); }
			});
		}
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
		this.renderStatus();
		this.renderInteraction(state);
		this.renderToolbar();
	}

	private renderToolbar(): void {
		const input = parseSlashCommandInput(this.input.value, this.slashCommands);
		const canSubmitIntent = input.kind === "message" ? input.text.trim().length > 0 || this.attachmentModel.attachments.some(attachment => attachment.kind !== 'toolSelection') : this.input.value.trim().length > 0;
		const localCommand = input.kind === 'command' && input.binding.origin === 'local';
		const state: ChatInputToolbarState = {
			mode: this.mode,
			canSubmit: canSubmitIntent && !this.submitting && this.state.phase !== 'submitting' && (localCommand || this.state.phase === 'ready' || this.state.phase === 'error'),
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
		const modeAction = this.options.modePicker === 'hidden' ? undefined : this.toolbarState.inputKind === "command"
			? new ChatInputAction("ash.chat.input.command", "Command", "Slash command", Lxicon.start, false, "mode", () => { })
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
						agentOptions.push(new ChatInputAction('ash.chat.input.agent.current', this.state.agentName, this.state.agentName, Lxicon.unlimited, false, 'mode', () => { }, true));
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
		const micAction = { ...this.dictationSession.action };
		let sendAction: ChatInputAction;
		if (this.toolbarState.hasInput) {
			const tooltip = this.toolbarState.inputKind === "command" ? "Run command" : "Send message";
			sendAction = new ChatInputAction("ash.chat.input.send", "Send", tooltip, Lxicon.arrowUp, this.toolbarState.canSubmit, "send", () => this.inputContainer.requestSubmit());
		} else {
			sendAction = new ChatInputAction("ash.chat.input.voice", localize('chat.input.voice', 'Voice conversation'), localize('chat.input.voiceUnavailable', 'Voice conversation is unavailable'), Lxicon.voiceMode, false, "voice", () => { });
		}
		const trailingActions = this.toolbarState.canInterrupt
			? [
				sendAction,
				new ChatInputAction("ash.chat.input.interrupt", "Stop", "Stop response", Lxicon.close, true, "interrupt", () => void this.delegate.interrupt()),
			]
			: [sendAction];
		// Localized getters must be evaluated for each presentation; ActionBar retains identical action objects.
		const additionalActions = this.additionalActions.filter(action => action.id !== 'ash.chat.input.attach').map(action => ({ ...action, run: (...args: readonly unknown[]) => action.run(...args) }));
		additionalActions.unshift({
			id: 'ash.chat.input.attach', label: localize('chat.context.add', 'Add context'), tooltip: localize('chat.context.add', 'Add context'), icon: Lxicon.add, enabled: true,
			run: () => {
				// The command creates the picker owner only when this composer opens it.
				this.attachContext.value ??= this.instantiationService.createInstance(AttachContextAction, {
					container: this.inputContainer, target: this, focusInput: () => this.focus(), supportsImages: () => this.supportsImages(), getDisabledTools: async () => {
						const selection = this.attachmentModel.attachments.find(attachment => attachment.kind === 'toolSelection');
						return selection ? JSON.parse((await selection.resolve()).content) as string[] : [];
					}
				});
				return this.attachContext.value.run();
			},
		});
		const modeActions = modeAction ? [modeAction] : [];
		const inputActions = this.toolbarState.inputKind === "command" ? modeActions : [...additionalActions, ...modeActions, this.modelAction, micAction];
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
			leadingActions: [permissions],
			presentation: 'inherit-foreground',
			toolbarOptions: { primaryGroup: () => true },
			actionViewItemProvider: action => {
				if (action !== permissions) return undefined;
				this.permissionWidget = this.instantiationService.createInstance(PermissionPickerActionItem, action, this.footerChanged.event, {
					getActions: () => approvalModeDefinitions.map(definition => ({
						id: definition.id,
						label: localize(definition.label.key, definition.label.text),
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

	private renderAttachments(): void {
		const attachments = this.attachmentModel.attachments;
		for (const [id, widget] of this.attachmentWidgets) {
			if (!attachments.includes(widget.attachment)) { this.attachmentWidgets.deleteAndDispose(id); }
		}
		for (const attachment of attachments) {
			if (this.attachmentWidgets.has(attachment.id)) { continue; }
			const Widget = attachment.kind === 'image' ? ImageAttachmentWidget : DefaultChatAttachmentWidget;
			const widget = this.instantiationService.createInstance(Widget, this.attachmentList, attachment, () => {
				const index = this.attachmentModel.attachments.indexOf(attachment);
				this.attachmentModel.delete(attachment.id);
				const remaining = this.attachmentModel.attachments;
				const next = remaining[Math.min(index, remaining.length - 1)];
				if (next) { this.attachmentWidgets.get(next.id)!.removeButton.domNode.focus(); }
				else { this.focus(); }
				announceStatus(localize('chat.context.removed', 'Removed {0}', attachment.name));
			});
			this.attachmentWidgets.set(attachment.id, widget);
		}
		for (const [index, attachment] of attachments.entries()) {
			const domNode = this.attachmentWidgets.get(attachment.id)!.domNode;
			if (this.attachmentList.children[index] !== domNode) { this.attachmentList.insertBefore(domNode, this.attachmentList.children[index] ?? null); }
		}
		const isEmpty = attachments.length === 0;
		this.attachmentList.classList.toggle('empty', isEmpty);
		this.attachmentList.hidden = isEmpty;
	}

	private createToolbarViewItem(action: IAction, contextViewService: IContextViewService): ActionViewItem | undefined {
		if (action.id === this.dictationSession.action.id) { return new DictationActionViewItem(action); }
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
			return this.instantiationService.createInstance(ModePickerActionItem, action, this.mode, () => {
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
		if (state.error) return state.error;
		if (this.dictationSession.isActive && this.speechToText.state === SpeechToTextState.Transcribing) return localize('chat.input.dictationTranscribing', 'Transcribing…');
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
