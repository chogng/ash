import { AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING } from './sessionsChatHistory.js';
import { IChatContextService } from '../../../../workbench/contrib/chat/browser/contextContrib/chatContextService.js';
import { IChatSlashCommandService } from '../../../../workbench/contrib/chat/common/participants/chatSlashCommands.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import * as chatInputStatePersistence from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IImageEditorService } from '../../../../workbench/services/imageEditor/common/imageEditorService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatSpeechToTextService } from '../../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { IVoiceInputModeService } from '../../../../workbench/contrib/chat/browser/voiceInputMode/voiceInputMode.js';
import { IDictationOnboardingService } from '../../../../workbench/contrib/chat/browser/speechToText/dictationOnboarding.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate, ChatInputState } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { IChatInputNoticeHubService } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputNoticeHub.js';
import { IChatInputNotificationService } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputNotificationService.js';
import { IVoiceModeOnboardingService } from '../../../../workbench/contrib/agentsVoice/browser/voiceModeOnboarding.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { IChatAttachmentResolveService } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { PermissionPickerActionItem } from '../../../../workbench/contrib/chat/browser/widget/input/permissionPickerActionItem.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { approvalModeDefinition, approvalModeDefinitions } from '../../../../platform/agentHost/common/approvalModes.js';
import { IApprovalEnvironmentService } from '../../../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import { OPEN_GUARDIAN_SETUP_COMMAND_ID } from '../../../../workbench/contrib/chat/common/chat.js';
import { getSessionsChatAccessibilityHelp } from './sessionsChatAccessibilityHelp.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../common/newChatDraftState.js';
import { status as announceStatus } from '../../../../base/browser/ui/aria/aria.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';

/** Applies Sessions editor, attachment and draft policy to the shared input. */
export class NewChatInputWidget extends ChatInputPart {
	private readonly permissionPicker: PermissionPickerActionItem;

	constructor(
		container: HTMLElement,
		delegate: ChatInputDelegate,
		private readonly model: IChatWidgetModel,
		@IChatSpeechToTextService speechToText: IChatSpeechToTextService,
		@IVoiceInputModeService voiceInputMode: IVoiceInputModeService,
		@IDictationOnboardingService onboarding: IDictationOnboardingService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextViewService contextViews: IContextViewService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService private readonly storage: IStorageService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IQuickInputService quickInput: IQuickInputService,
		@IMenuService menuService: IMenuService,
		@IChatAttachmentResolveService attachmentResolver: IChatAttachmentResolveService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IChatInputNoticeHubService noticeHub: IChatInputNoticeHubService,
		@IChatInputNotificationService inputNotifications: IChatInputNotificationService,
		@IVoiceModeOnboardingService voiceOnboarding: IVoiceModeOnboardingService,
		@IConfigurationService configuration: IConfigurationService,
		@IActionViewItemService presentations: IActionViewItemService,
		@IChatWidgetService chatWidgets: IChatWidgetService,
		@IChatSlashCommandService clientCommands: IChatSlashCommandService,
		@IImageEditorService imageEditors: IImageEditorService,
		@IChatContextService providedContexts: IChatContextService,
		@ICommandService commands: ICommandService,
		@IApprovalEnvironmentService approvalEnvironment: IApprovalEnvironmentService | undefined,
	) {
		super(container, delegate, contextMenus, contextViews, accessibleViews, notifications, {
			create: options => instantiationService.createInstance(ChatInputEditor, {
				...options,
				placeholder: localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
				// Let the row center the actual text height beside its 28px controls.
				height: { minimum: 0, maximum: 240 },
			}),
		}, [], { layout: 'compact', modePicker: 'visible', modelPickerPosition: 'trailing', renderSecondaryToolbar: false, draftStorage: 'host' }, instantiationService, speechToText, voiceInputMode, onboarding, quickInput, menuService, attachmentResolver, contextKeys, noticeHub, inputNotifications, voiceOnboarding, configuration, presentations, chatWidgets, commands, clientCommands, imageEditors, providedContexts);
		const footer = this.inputFooter!;
		const owner = this;
		const permissionHost = h(container.ownerDocument, 'div');
		permissionHost.className = 'ash-sessions-permission-picker';
		footer.prepend(permissionHost);
		this.createContextUsageToolbar(footer, contextMenus);
		this.permissionPicker = this._register(instantiationService.createInstance(PermissionPickerActionItem, {
			id: 'sessions.chat.permissions',
			get label() {
				const definition = approvalModeDefinition(owner.model.inputState.approvalMode);
				return localize(definition.label.key, definition.label.text);
			},
			get tooltip() {
				const definition = approvalModeDefinition(owner.model.inputState.approvalMode);
				return localize('sessions.chat.permission.label', 'Permissions: {0}', localize(definition.label.key, definition.label.text));
			},
			get enabled() { return !owner.model.inputState.aiDisabled && owner.model.inputState.phase !== 'submitting'; },
			run: () => this.permissionPicker.show(),
		}, model.onDidChange, {
			getActions: () => [...approvalModeDefinitions.map(definition => ({
				id: definition.id,
				label: localize(definition.label.key, definition.label.text),
				tooltip: localize(definition.description.key, definition.description.text),
				enabled: true,
				checked: definition.id === model.inputState.approvalMode,
				run: () => commands.executeCommand(`sessions.chat.permission.${definition.id}`, model),
			})), ...(approvalEnvironment ? [{
				id: OPEN_GUARDIAN_SETUP_COMMAND_ID,
				label: localize('approvalEnvironment.title', 'Prepare review environment…'),
				enabled: true,
				run: () => commands.executeCommand(OPEN_GUARDIAN_SETUP_COMMAND_ID, model),
			}] : [])],
		}));
		this.permissionPicker.render(permissionHost);
		this._register(addDisposableListener(this.inputContainer, 'focusin', event => {
			if (this.inputContainer.contains(event.relatedTarget as Node | null)) return;
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
			if (hint) announceStatus(hint);
		}));
		const updateHistoryScope = () => this.setHistoryScope(configuration.getValue<boolean>(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING) === false
			? undefined : JSON.stringify(model.sessionId ? ['sessions', model.sessionId] : ['sessions-draft', model.untitledSessionId]));
		updateHistoryScope();
		this._register(model.onDidChange(updateHistoryScope));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AGENT_SESSIONS_SCOPED_INPUT_HISTORY_SETTING)) updateHistoryScope();
		}));
		this.bindDraftStorage(model, {
			read: identity => readNewChatDraftState(storage, identity, chatInputStatePersistence),
			write: (identity, draft) => writeNewChatDraftState(storage, draft, identity, chatInputStatePersistence),
			flush: () => storage.flush(),
		}, lifecycle.onWillShutdown);
	}

	public async persistDraftForHostChange(): Promise<void> {
		const id = this.model.untitledSessionId;
		const snapshot = await this.captureDraft();
		if (this.isDisposed || !id || this.model.untitledSessionId !== id) return;
		if (snapshot) writeNewChatDraftState(this.storage, snapshot.draft, `untitled:${id}`, chatInputStatePersistence);
	}

	protected override getAccessibilityHelpContent(): string {
		return super.getAccessibilityHelpContent() + '\n' + getSessionsChatAccessibilityHelp();
	}

	/** Composition slots owned by this input; the Sessions widget places surrounding surfaces. */
	public get inputContainerElement(): HTMLElement { return this.inputContainer; }
	public get inputFooterElement(): HTMLElement { return this.inputFooter!; }

	protected override statusText(state: ChatInputState): string {
		// Catalog loading keeps the local draft's welcome content in place; aria-busy exposes readiness.
		if (!state.aiDisabled && this.model.untitledSessionId !== undefined && state.phase === 'loading' && !state.error) {
			return '';
		}
		return super.statusText(state);
	}

	public override invalidatePendingInput(): void {
		super.invalidatePendingInput();
		this.permissionPicker?.hide();
	}

	public override openPermissionPicker(): void {
		if (!this.isDisposed && this.visible && !this.model.inputState.aiDisabled) this.permissionPicker.show();
	}

}
