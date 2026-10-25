import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import './media/chatInput.css';
import '../../../common/theme.js';
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
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { IChatAttachmentResolveService } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { ChatDragAndDrop } from '../../../../workbench/contrib/chat/browser/widget/chatDragAndDrop.js';
import { NewChatContextAttachments } from './newChatContextAttachments.js';
import { NewChatPermissionPicker } from './newChatPermissionPicker.js';
import { approvalModeDefinition } from '../../../../platform/agentHost/common/approvalModes.js';
import { NewChatInputPasteTarget } from './newChatInputPasteTarget.js';
import { ChatInputTipPresenter } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputTipPresenter.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { SessionsChatAccessibilityHelp } from './sessionsChatAccessibilityHelp.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../common/newChatDraftState.js';
import { status as announceStatus } from '../../../../base/browser/ui/aria/aria.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SessionChatInputToolbar } from './sessionChatInputToolbar.js';

/** Sessions owns its composer layout and editor policy while sharing input operations.
 * 
 */
export class NewChatInputWidget extends ChatInputPart {
	private readonly heading: HTMLHeadingElement;
	private submittedMessage = false;
	private displayedThreadId: string | undefined;
	private readonly contextAttachments: NewChatContextAttachments;
	private readonly tips: ChatInputTipPresenter;
	private readonly permissionButton: HTMLButtonElement;

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
	) {
		super(container, {
			...delegate,
			send: async (text, mode, skills, contexts, submissionSignal) => {
				if (this.isDisposed || submissionSignal?.aborted) return;
				this.submittedMessage = true;
				this.updateConversation();
				try {
					await delegate.send(text, mode, skills, contexts, submissionSignal);
				} catch (error) {
					// A retired submission must not change the newly selected conversation's welcome state.
					if (!this.isDisposed && !submissionSignal?.aborted) {
						if (this.model.items.length === 0) {
							this.submittedMessage = false;
						}
						this.updateConversation();
					}
					throw error;
				}
			},
		}, contextMenus, contextViews, accessibleViews, notifications, {
			create: options => instantiationService.createInstance(ChatInputEditor, {
				...options,
				height: { minimum: 32, maximum: 240 },
			}),
		}, [{
			id: 'ash.chat.input.attach',
			get label() { return localize('chat.attach.files', 'Attach files'); },
			get tooltip() { return localize('chat.attach.files', 'Attach files'); },
			icon: Lxicon.add,
			enabled: true,
			run: () => this.contextAttachments.showPicker(),
		}], { modePicker: 'visible', modelPickerPosition: 'leading', renderSecondaryToolbar: false, fileEvents: 'host', draftStorage: 'host' }, instantiationService, speechToText, onboarding, quickInput, menuService, attachmentResolver);
		this.element.classList.add('ash-sessions-chat-input', 'floating-card');
		this.element.classList.add('chat-composer');
		const pullRequests = this._register(instantiationService.createInstance(SessionChatInputToolbar, this.element, model));
		this.element.insertBefore(pullRequests.domNode, this.inputContainer);
		pullRequests.render();
		this.contextAttachments = this._register(new NewChatContextAttachments(this.inputContainer, files => this.attachFiles(files)));
		this._register(new NewChatInputPasteTarget(this.inputContainer, this.contextAttachments));
		const dragAndDrop = this._register(instantiationService.createInstance(ChatDragAndDrop, this, () => this.supportsImages()));
		dragAndDrop.addOverlay(this.inputContainer, this.inputContainer);
		const tipContainer = h(container.ownerDocument, 'div');
		tipContainer.className = 'ash-sessions-chat-tip-slot';
		this.tips = this._register(instantiationService.createInstance(ChatInputTipPresenter, {
			container: tipContainer,
			isEligible: () => !this.submittedMessage && this.model.items.length === 0
				&& (this.model.inputState.phase === 'ready' || (this.model.untitledSessionId !== undefined && this.model.inputState.phase === 'loading'))
				&& !this.model.inputState.interaction,
			focusInput: () => this.focus(),
		}));
		const footer = h(container.ownerDocument, 'div');
		footer.className = 'ash-sessions-chat-input-footer';
		this.permissionButton = h(container.ownerDocument, 'button', { className: 'ash-button ash-button-small ash-button-quiet' });
		this.permissionButton.type = 'button';
		this.permissionButton.setAttribute('aria-haspopup', 'menu');
		this.permissionButton.setAttribute('aria-expanded', 'false');
		footer.append(this.permissionButton);
		this.createContextUsageToolbar(footer, contextMenus);
		this.element.append(footer);
		this.element.append(tipContainer);
		this._register(instantiationService.createInstance(NewChatPermissionPicker, this.permissionButton, this.model));
		this._register(AccessibleViewRegistry.register(new SessionsChatAccessibilityHelp(this.element, () => this.focus())));
		this._register(addDisposableListener(this.inputContainer, 'focusin', event => {
			if (this.inputContainer.contains(event.relatedTarget as Node | null)) return;
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
			if (hint) announceStatus(hint);
		}));
		this.heading = h(container.ownerDocument, 'h2');
		this.heading.className = 'ash-sessions-chat-welcome-heading';
		this.heading.textContent = localize('sessions.chat.welcome', 'What can we work on?');
		this.element.prepend(this.heading);
		this.displayedThreadId = model.threadId;
		this.bindDraftStorage(model, {
			read: identity => readNewChatDraftState(storage, identity),
			write: (identity, draft) => writeNewChatDraftState(storage, draft, identity),
			flush: () => storage.flush(),
		}, lifecycle.onWillShutdown);
		this._register(model.onDidChange(() => {
			if (this.displayedThreadId !== model.threadId && this.displayedThreadId !== undefined) this.submittedMessage = false;
			this.displayedThreadId = model.threadId;
			this.updateConversation();
		}));
		this.updateConversation();
	}

	protected override statusText(state: ChatInputState): string {
		// Catalog loading keeps the local draft's welcome content in place; aria-busy exposes readiness.
		if (!state.aiDisabled && this.model.untitledSessionId !== undefined && state.phase === 'loading' && !state.error) {
			return '';
		}
		return super.statusText(state);
	}

	private updateConversation(): void {
		const hasConversation = this.submittedMessage || this.model.items.length > 0;
		this.element.setAttribute('aria-busy', String(this.model.inputState.phase === 'loading'));
		this.element.classList.toggle('has-conversation', hasConversation);
		this.heading.hidden = hasConversation;
		this.tips.update();
		const permission = this.model.inputState.approvalMode;
		const definition = approvalModeDefinition(permission);
		const label = localize(definition.label.key, definition.label.text);
		this.permissionButton.textContent = label;
		this.permissionButton.setAttribute('aria-label', localize('sessions.chat.permission.label', 'Permissions: {0}', label));
		this.permissionButton.disabled = this.model.inputState.phase === 'submitting';
	}
}
