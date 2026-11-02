import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatSpeechToTextService } from '../../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { IDictationOnboardingService } from '../../../../workbench/contrib/chat/browser/speechToText/dictationOnboarding.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate, ChatInputState } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { IChatInputNoticeHubService } from '../../../../workbench/contrib/chat/browser/widget/input/notices/chatInputNoticeHub.js';
import { IChatInputNotificationService } from '../../../../workbench/contrib/chat/browser/widget/input/notices/chatInputNotificationService.js';
import { IVoiceModeOnboardingService } from '../../../../workbench/contrib/agentsVoice/browser/voiceModeOnboarding.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { IChatAttachmentResolveService } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { PermissionPickerActionItem } from '../../../../workbench/contrib/chat/browser/widget/input/permissionPickerActionItem.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { approvalModeDefinition, approvalModeDefinitions } from '../../../../platform/agentHost/common/approvalModes.js';
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
		@IDictationOnboardingService onboarding: IDictationOnboardingService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextViewService contextViews: IContextViewService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storage: IStorageService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IQuickInputService quickInput: IQuickInputService,
		@IMenuService menuService: IMenuService,
		@IChatAttachmentResolveService attachmentResolver: IChatAttachmentResolveService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IChatInputNoticeHubService noticeHub: IChatInputNoticeHubService,
		@IChatInputNotificationService inputNotifications: IChatInputNotificationService,
		@IVoiceModeOnboardingService voiceOnboarding: IVoiceModeOnboardingService,
		@ICommandService commands: ICommandService,
	) {
		super(container, delegate, contextMenus, contextViews, accessibleViews, notifications, {
			create: options => instantiationService.createInstance(ChatInputEditor, {
				...options,
				placeholder: localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
				// Let the row center the actual text height beside its 28px controls.
				height: { minimum: 0, maximum: 240 },
			}),
		}, [], { layout: 'compact', modePicker: 'visible', modelPickerPosition: 'trailing', renderSecondaryToolbar: false, draftStorage: 'host' }, instantiationService, speechToText, onboarding, quickInput, menuService, attachmentResolver, contextKeys, noticeHub, inputNotifications, voiceOnboarding);
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
			getActions: () => approvalModeDefinitions.map(definition => ({
				id: definition.id,
				label: localize(definition.label.key, definition.label.text),
				tooltip: localize(definition.description.key, definition.description.text),
				enabled: true,
				checked: definition.id === model.inputState.approvalMode,
				run: () => commands.executeCommand(`sessions.chat.permission.${definition.id}`, model),
			})),
		}));
		this.permissionPicker.render(permissionHost);
		this._register(addDisposableListener(this.inputContainer, 'focusin', event => {
			if (this.inputContainer.contains(event.relatedTarget as Node | null)) return;
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
			if (hint) announceStatus(hint);
		}));
		this.bindDraftStorage(model, {
			read: identity => readNewChatDraftState(storage, identity),
			write: (identity, draft) => writeNewChatDraftState(storage, draft, identity),
			flush: () => storage.flush(),
		}, lifecycle.onWillShutdown);
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
