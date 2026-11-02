import { IChatSlashCommandService } from '../../../../workbench/contrib/chat/common/participants/chatSlashCommands.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import * as chatInputStatePersistence from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import './media/chatInput.css';
import '../../../common/theme.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatSpeechToTextService } from '../../../../workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { IVoiceInputModeService } from '../../../../workbench/contrib/chat/browser/voiceInputMode/voiceInputMode.js';
import { IDictationOnboardingService } from '../../../../workbench/contrib/chat/browser/speechToText/dictationOnboarding.js';
import type { ICoworkWidgetModel } from './widget/coworkWidget.js';
import type { ChatInputDelegate, ChatInputState } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { IChatInputNoticeHubService } from '../../../../workbench/contrib/chat/browser/widget/input/notices/chatInputNoticeHub.js';
import { IChatInputNotificationService } from '../../../../workbench/contrib/chat/browser/widget/input/notices/chatInputNotificationService.js';
import { IVoiceModeOnboardingService } from '../../../../workbench/contrib/agentsVoice/browser/voiceModeOnboarding.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { IChatAttachmentResolveService } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { ChatInputTipPresenter } from './widget/input/chatInputTipPresenter.js';
import { getCoworkChatAccessibilityHelp } from './sessionsChatAccessibilityHelp.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../../chat/common/newChatDraftState.js';
import { status as announceStatus } from '../../../../base/browser/ui/aria/aria.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';

/** Cowork owns its welcome layout and draft lifecycle; Workbench owns input operations. */
export class NewCoworkInputWidget extends ChatInputPart {
	private readonly heading: HTMLHeadingElement;
	private submittedMessage = false;
	private displayedThreadId: string | undefined;
	private displayedDraftId: string;
	private readonly tips: ChatInputTipPresenter;
	private draftVisible = false;
	private restoringDraft = false;
	private readonly draftWriteRevisions = new Map<string, number>();
	private readonly draftWrites = new Set<Promise<void>>();
	private readonly draftNotifications: INotificationService;

	constructor(
		container: HTMLElement,
		delegate: ChatInputDelegate,
		private readonly model: ICoworkWidgetModel,
		private readonly presentation: 'conversation' | 'embedded',
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
		@ICommandService commands: ICommandService,
	) {
		super(container, {
			...delegate,
			send: async (text, mode, skills, contexts, signal, queue) => {
				this.submittedMessage = true;
				this.updateConversation();
				try {
					await delegate.send(text, mode, skills, contexts, signal, queue);
				} catch (error) {
					if (this.model.items.length === 0) {
						this.submittedMessage = false;
					}
					this.updateConversation();
					throw error;
				}
			},
		}, contextMenus, contextViews, accessibleViews, notifications, {
			create: options => instantiationService.createInstance(ChatInputEditor, {
				...options,
				placeholder: presentation === 'embedded' ? localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question') : '',
				height: { minimum: 32, maximum: 240 },
			}),
		}, [], { modePicker: 'hidden', modelPickerPosition: 'trailing', renderSecondaryToolbar: false, draftStorage: 'host' }, instantiationService, speechToText, voiceInputMode, onboarding, quickInput, menuService, attachmentResolver, contextKeys, noticeHub, inputNotifications, voiceOnboarding, configuration, presentations, chatWidgets, commands, clientCommands);
		this.draftNotifications = notifications;
		this.element.classList.add('ash-sessions-cowork-input', 'floating-card');
		this.element.classList.add('cowork-composer');
		this.element.classList.toggle('embedded-composer', presentation === 'embedded');
		const tipContainer = h(container.ownerDocument, 'div');
		tipContainer.className = 'ash-sessions-cowork-tip-slot';
		this.element.append(tipContainer);
		this.tips = this._register(instantiationService.createInstance(ChatInputTipPresenter, {
			container: tipContainer,
			isEligible: () => !this.model.inputState.aiDisabled && !this.submittedMessage && this.model.items.length === 0
				&& (this.model.inputState.phase === 'ready' || (this.model.untitledSessionId !== undefined && this.model.inputState.phase === 'loading'))
				&& !this.model.inputState.interaction,
			focusInput: () => this.focus(),
		}, this.noticeHost));
		this._register(addDisposableListener(this.inputContainer, 'focusin', event => {
			if (this.inputContainer.contains(event.relatedTarget as Node | null)) return;
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
			if (hint) announceStatus(hint);
		}));
		this.heading = h(container.ownerDocument, 'h2');
		this.heading.className = 'ash-sessions-cowork-welcome-heading';
		this.heading.textContent = localize('sessions.chat.welcome', 'What can we work on?');
		this.element.prepend(this.heading);
		this.displayedThreadId = model.threadId;
		this.displayedDraftId = model.threadId ?? `untitled:${model.untitledSessionId!}`;
		const storedDraft = readNewChatDraftState(storage, this.displayedDraftId, chatInputStatePersistence);
		if (storedDraft) this.restoreDraft(storedDraft);
		this._register(this.onDidChangeInput(() => {
			if (!this.restoringDraft) {
				this.saveDraft();
			}
		}));
		this._register(lifecycle.onWillShutdown(event => {
			event.join(Promise.all([...this.draftWrites]).then(() => storage.flush()), 'Sessions composer draft');
		}));
		this._register(toDisposable(() => {
			// A pane can close while attachment resolution is still running; it must not recreate its draft.
			for (const [identity, revision] of this.draftWriteRevisions) {
				this.draftWriteRevisions.set(identity, revision + 1);
			}
		}));
		this._register(model.onDidChange(() => {
			if (this.displayedThreadId !== model.threadId) {
				// Materializing the draft does not start another conversation; switching an existing Thread does.
				if (this.displayedThreadId !== undefined) {
					this.saveDraft();
					this.submittedMessage = false;
					this.restoringDraft = true;
					this.input.value = '';
					this.attachmentModel.clear();
					const draft = readNewChatDraftState(storage, model.threadId ?? `untitled:${model.untitledSessionId!}`, chatInputStatePersistence);
					if (draft) this.restoreDraft(draft);
					this.restoringDraft = false;
				} else {
					// A successful materialization consumes the new-session identity and its persisted draft.
					this.draftWriteRevisions.set(this.displayedDraftId, (this.draftWriteRevisions.get(this.displayedDraftId) ?? 0) + 1);
					writeNewChatDraftState(storage, undefined, this.displayedDraftId, chatInputStatePersistence);
				}
				this.displayedThreadId = model.threadId;
				this.displayedDraftId = model.threadId ?? `untitled:${model.untitledSessionId!}`;
				this.saveDraft();
			}
			this.updateConversation();
		}));
		this.updateConversation();
	}

	protected override getAccessibilityHelpContent(): string {
		return super.getAccessibilityHelpContent() + '\n' + getCoworkChatAccessibilityHelp();
	}

	public override setVisible(visible: boolean): void {
		this.element.hidden = !visible;
		super.setVisible(visible);
		const becameVisible = visible && !this.draftVisible;
		this.draftVisible = visible;
		if (becameVisible) this.saveDraft();
	}

	protected override statusText(state: ChatInputState): string {
		// Catalog loading keeps the local draft's welcome content in place; aria-busy exposes readiness.
		if (!state.aiDisabled && this.model.untitledSessionId !== undefined && state.phase === 'loading' && !state.error) {
			return '';
		}
		return super.statusText(state);
	}

	private saveDraft(): void {
		const operation = this.writeDraft();
		this.draftWrites.add(operation);
		void operation.then(() => this.draftWrites.delete(operation), error => {
			this.draftWrites.delete(operation);
			this.draftNotifications.error(localize('sessions.chat.draftFailed', 'Could not save the Chat draft: {0}', String(error)));
		});
	}

	private async writeDraft(): Promise<void> {
		const draftId = this.displayedDraftId;
		const revision = (this.draftWriteRevisions.get(draftId) ?? 0) + 1;
		this.draftWriteRevisions.set(draftId, revision);
		const { text, contexts: attachments } = this.snapshotDraftReferences();
		const mode = this.model.inputState.mode;
		if (attachments.length === 0) {
			writeNewChatDraftState(this.storage, { mode, text, contexts: [] }, draftId, chatInputStatePersistence);
			return;
		}
		const contexts = await Promise.all(attachments.map(async attachment => ({
			id: attachment.id, kind: attachment.kind, name: attachment.name,
			content: (await attachment.resolve()).content,
			...(attachment.resource ? { resource: attachment.resource.toString() } : {}),
			...(attachment.reference ? { reference: attachment.reference } : {}),
			...(attachment.terminalSnapshot ? { terminalSnapshot: attachment.terminalSnapshot } : {}),
		})));
		if (revision !== this.draftWriteRevisions.get(draftId)) return;
		writeNewChatDraftState(this.storage, { mode, text, contexts }, draftId, chatInputStatePersistence);
	}

	private updateConversation(): void {
		const hasConversation = this.submittedMessage || this.model.items.length > 0;
		this.element.setAttribute('aria-busy', String(this.model.inputState.phase === 'loading'));
		this.element.classList.toggle('has-conversation', hasConversation);
		this.heading.hidden = hasConversation || this.presentation === 'embedded';
		this.tips.update();
	}
}
