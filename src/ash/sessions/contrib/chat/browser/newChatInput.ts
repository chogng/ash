import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IMenuService } from '../../../../platform/actions/common/actions.js';
import './media/chatInput.css';
import '../../../common/theme.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
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
import { ChatDragAndDrop } from '../../../../workbench/contrib/chat/browser/widget/chatDragAndDrop.js';
import { NewChatContextAttachments } from './newChatContextAttachments.js';
import { NewChatPermissionPicker } from './newChatPermissionPicker.js';
import { approvalModeDefinition } from '../../../../platform/agentHost/common/approvalModes.js';
import { NewChatInputPasteTarget } from './newChatInputPasteTarget.js';
import { ChatInputTipPresenter } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputTipPresenter.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { SessionsChatAccessibilityHelp } from './sessionsChatAccessibilityHelp.js';
import type { IOpenAgentsWindowOptions } from '../../../../platform/native/common/nativeHost.js';
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
	private displayedDraftId: string;
	private readonly contextAttachments: NewChatContextAttachments;
	private readonly tips: ChatInputTipPresenter;
	private readonly permissionButton: HTMLButtonElement;
	private draftVisible = false;
	private restoringDraft = false;
	private draftRestoreFailed = false;
	private readonly draftWriteRevisions = new Map<string, number>();
	private readonly draftWrites = new Set<Promise<void>>();
	private readonly draftNotifications: INotificationService;

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
		@IStorageService private readonly storage: IStorageService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IQuickInputService quickInput: IQuickInputService,
		@IMenuService menuService: IMenuService,
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
				height: { minimum: 48, maximum: 240 },
			}),
		}, [{
			id: 'ash.chat.input.attach',
			get label() { return localize('chat.attach.files', 'Attach files'); },
			get tooltip() { return localize('chat.attach.files', 'Attach files'); },
			icon: Lxicon.add,
			enabled: true,
			run: () => this.contextAttachments.showPicker(),
		}], { modePicker: 'visible', modelPickerPosition: 'leading', renderSecondaryToolbar: false, fileEvents: 'host' }, instantiationService, speechToText, onboarding, quickInput, menuService);
		this.draftNotifications = notifications;
		this.element.classList.add('ash-sessions-chat-input', 'floating-card');
		this.element.classList.add('chat-composer');
		const pullRequests = this._register(instantiationService.createInstance(SessionChatInputToolbar, this.element, model));
		this.element.insertBefore(pullRequests.domNode, this.inputContainer);
		pullRequests.render();
		this.contextAttachments = this._register(new NewChatContextAttachments(this.inputContainer, files => this.attachFiles(files)));
		this._register(new NewChatInputPasteTarget(this.inputContainer, this.contextAttachments));
		const dragAndDrop = this._register(new ChatDragAndDrop(files => this.contextAttachments.attachFiles(files)));
		dragAndDrop.addOverlay(this.inputContainer, this.inputContainer);
		const tipContainer = h(container.ownerDocument, 'div');
		tipContainer.className = 'ash-sessions-chat-tip-slot';
		this.element.insertBefore(tipContainer, this.inputContainer);
		this.tips = this._register(instantiationService.createInstance(ChatInputTipPresenter, {
			container: tipContainer,
			isEligible: () => !this.submittedMessage && this.model.items.length === 0
				&& (this.model.inputState.phase === 'ready' || (this.model.untitledSessionId !== undefined && this.model.inputState.phase === 'loading'))
				&& !this.model.inputState.interaction,
			focusInput: () => this.focus(),
		}));
		const footer = h(container.ownerDocument, 'div');
		footer.className = 'ash-sessions-chat-input-footer';
		this.permissionButton = h(container.ownerDocument, 'button');
		this.permissionButton.type = 'button';
		this.permissionButton.setAttribute('aria-haspopup', 'menu');
		this.permissionButton.setAttribute('aria-expanded', 'false');
		footer.append(this.permissionButton);
		this.createContextUsageToolbar(footer, contextMenus);
		this.element.append(footer);
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
		this.displayedDraftId = model.threadId ?? `untitled:${model.untitledSessionId!}`;
		this.restoreStoredDraft(this.displayedDraftId);
		this._register(this.onDidChangeInput(() => {
			if (!this.restoringDraft) {
				this.draftRestoreFailed = false;
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
					this.restoreStoredDraft(model.threadId ?? `untitled:${model.untitledSessionId!}`);
					this.restoringDraft = false;
				} else {
					// A successful materialization consumes the new-session identity and its persisted draft.
					this.draftWriteRevisions.set(this.displayedDraftId, (this.draftWriteRevisions.get(this.displayedDraftId) ?? 0) + 1);
					writeNewChatDraftState(storage, undefined, this.displayedDraftId);
				}
				this.displayedThreadId = model.threadId;
				this.displayedDraftId = model.threadId ?? `untitled:${model.untitledSessionId!}`;
				this.saveDraft();
			}
			this.updateConversation();
		}));
		this.updateConversation();
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

	private restoreStoredDraft(draftId: string): void {
		this.draftRestoreFailed = false;
		try {
			const draft = readNewChatDraftState(this.storage, draftId);
			if (draft) this.restoreDraft(draft);
		} catch (error) {
			// Keep the original entry until the user edits; merely showing the empty composer must not erase it.
			this.draftRestoreFailed = true;
			this.draftNotifications.error(localize('sessions.chat.draftRestoreFailed', 'Could not restore the Chat draft: {0}', String(error)));
		}
	}

	private saveDraft(): void {
		if (this.draftRestoreFailed) return;
		const operation = this.writeDraft();
		this.draftWrites.add(operation);
		void operation.then(() => this.draftWrites.delete(operation), error => {
			this.draftWrites.delete(operation);
			if (!this.isDisposed) this.draftNotifications.error(localize('sessions.chat.draftFailed', 'Could not save the Chat draft: {0}', String(error)));
		});
	}

	private async writeDraft(): Promise<void> {
		const draftId = this.displayedDraftId;
		const revision = (this.draftWriteRevisions.get(draftId) ?? 0) + 1;
		this.draftWriteRevisions.set(draftId, revision);
		const text = this.input.value;
		const mode = this.model.inputState.mode;
		const attachments = this.contexts.filter(attachment => attachment.lifetime !== 'source');
		if (attachments.length === 0) {
			writeNewChatDraftState(this.storage, { mode, text, contexts: [] }, draftId);
			return;
		}
		const contexts = await Promise.all(attachments.map(async attachment => ({
			id: attachment.id, kind: attachment.kind, name: attachment.name,
			content: (await attachment.resolve()).content,
			...(attachment.resource ? { resource: attachment.resource.toString() } : {}),
			...(attachment.reference ? { reference: attachment.reference } : {}),
			...(attachment.terminalSnapshot ? { terminalSnapshot: attachment.terminalSnapshot } : {}),
		}))).catch(error => {
			// A removed attachment or closed pane no longer owns a persistence error.
			if (revision !== this.draftWriteRevisions.get(draftId)) return undefined;
			throw error;
		});
		if (!contexts || revision !== this.draftWriteRevisions.get(draftId)) return;
		writeNewChatDraftState(this.storage, { mode, text, contexts }, draftId);
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
