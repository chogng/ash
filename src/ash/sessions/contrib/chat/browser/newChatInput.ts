import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
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
import { ChatDragAndDrop } from '../../../../workbench/contrib/chat/browser/widget/chatDragAndDrop.js';
import { NewChatContextAttachments } from './newChatContextAttachments.js';
import { NewChatPermissionPicker } from './newChatPermissionPicker.js';
import { approvalModeDefinition } from '../../../../platform/agentHost/common/approvalModes.js';
import { NewChatInputPasteTarget } from './newChatInputPasteTarget.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { SessionsChatAccessibilityHelp } from './sessionsChatAccessibilityHelp.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../common/newChatDraftState.js';
import { status as announceStatus } from '../../../../base/browser/ui/aria/aria.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';

/** Applies Sessions editor, attachment and draft policy to the shared input. */
export class NewChatInputWidget extends ChatInputPart {
	private readonly contextAttachments: NewChatContextAttachments;
	private readonly permissionButton: HTMLButtonElement;
	private readonly permissionPicker: NewChatPermissionPicker;

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
	) {
		super(container, delegate, contextMenus, contextViews, accessibleViews, notifications, {
			create: options => instantiationService.createInstance(ChatInputEditor, {
				...options,
				placeholder: localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
				// Let the row center the actual text height beside its 28px controls.
				height: { minimum: 0, maximum: 240 },
			}),
		}, [{
			id: 'ash.chat.input.attach',
			get label() { return localize('chat.attach.files', 'Attach files'); },
			get tooltip() { return localize('chat.attach.files', 'Attach files'); },
			icon: Lxicon.add,
			enabled: true,
			run: () => this.contextAttachments.showPicker(),
		}], { layout: 'compact', modePicker: 'visible', modelPickerPosition: 'trailing', renderSecondaryToolbar: false, fileEvents: 'host', draftStorage: 'host' }, instantiationService, speechToText, onboarding, quickInput, menuService, attachmentResolver, contextKeys, noticeHub, inputNotifications, voiceOnboarding);
		this.contextAttachments = this._register(new NewChatContextAttachments(this.inputContainer, files => this.attachFiles(files)));
		this._register(new NewChatInputPasteTarget(this.inputContainer, this.contextAttachments));
		const dragAndDrop = this._register(instantiationService.createInstance(ChatDragAndDrop, this, () => this.supportsImages()));
		dragAndDrop.addOverlay(this.inputContainer, this.inputContainer);
		const footer = this.inputFooter!;
		this.permissionButton = h(container.ownerDocument, 'button', { className: 'ash-button ash-button-small ash-button-quiet' });
		this.permissionButton.type = 'button';
		this.permissionButton.setAttribute('aria-haspopup', 'menu');
		this.permissionButton.setAttribute('aria-expanded', 'false');
		footer.prepend(this.permissionButton);
		this.createContextUsageToolbar(footer, contextMenus);
		this.permissionPicker = this._register(instantiationService.createInstance(NewChatPermissionPicker, this.permissionButton, this.model));
		this._register(AccessibleViewRegistry.register(new SessionsChatAccessibilityHelp(this.element, () => this.focus())));
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
		this._register(model.onDidChange(() => this.updatePermission()));
		this.updatePermission();
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

	private updatePermission(): void {
		const permission = this.model.inputState.approvalMode;
		const definition = approvalModeDefinition(permission);
		const label = localize(definition.label.key, definition.label.text);
		this.permissionButton.textContent = label;
		this.permissionButton.setAttribute('aria-label', localize('sessions.chat.permission.label', 'Permissions: {0}', label));
		this.permissionButton.disabled = this.model.inputState.phase === 'submitting';
	}

}
