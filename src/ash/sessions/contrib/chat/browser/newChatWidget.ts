import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { h } from '../../../../base/browser/dom.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { ChatInputTipPresenter } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputTipPresenter.js';
import { IVoiceModeOnboardingService } from '../../../../workbench/contrib/agentsVoice/browser/voiceModeOnboarding.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { NewChatInputWidget } from './newChatInput.js';
import { SessionChatInputToolbar } from './sessionChatInputToolbar.js';
import { SessionWorkspacePicker } from './sessionWorkspacePicker.js';
import { refreshChatInputStack } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStack.js';
import './media/chatInput.css';
import '../../../common/theme.js';

/** Owns the Code chat surface and its input while retaining the shared transcript and send pipeline. */
export class NewChatWidget extends ChatWidget<ChatWidgetModel> {
	declare readonly input: NewChatInputWidget;
	private readonly tips: ChatInputTipPresenter;
	private readonly workspacePicker: SessionWorkspacePicker;
	private submittedInput = false;
	private composerThreadId: string | undefined;

	constructor(
		container: HTMLElement,
		panelId: string,
		model: ChatWidgetModel,
		createNewSession: () => void,
		@IInstantiationService instantiationService: IInstantiationService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IContextViewService contextViews: IContextViewService,
		@ICommandService commands: ICommandService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@IDialogService dialogs: IDialogService,
		@IQuickInputService quickInput: IQuickInputService,
		@IChatWidgetService widgets: IChatWidgetService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IVoiceModeOnboardingService voiceOnboarding: IVoiceModeOnboardingService,
		@IEditorService editors: IEditorService,
	) {
		super(container, panelId, model, createNewSession, contextMenus, contextViews, commands, accessibleViews, notifications,
			undefined, undefined, undefined,
			(inputContainer, delegate) => instantiationService.createInstance(NewChatInputWidget, inputContainer, {
				...delegate,
				send: async (...args: Parameters<ChatInputDelegate['send']>) => {
					const submissionSignal = args[4];
					if (this.isDisposed || submissionSignal?.aborted) {
						return;
					}
					this.submittedInput = true;
					this.updateComposer();
					try {
						await delegate.send(...args);
					} catch (error) {
						// A retired send must not change the welcome state of the newly selected conversation.
						if (!this.isDisposed && !submissionSignal?.aborted) {
							if (model.items.length === 0) {
								this.submittedInput = false;
							}
							this.updateComposer();
						}
						throw error;
					}
				},
			}, model), {
			promptTimelineFiles: prompt => {
				const source = prompt.requestSource;
				if (!source || source.sessionId !== model.sessionId || source.threadId !== model.threadId) return [];
				return model.changeSets.filter(summary => summary.turnId === source.turnId && summary.captureState !== 'discarded')
					.flatMap(summary => model.turnChangeDetails(summary.changeSetId)?.files.map(file => ({
						id: JSON.stringify([summary.changeSetId, file.path]),
						path: file.path,
						review: async () => {
							try {
								const review = await model.createPromptChangeReview(summary, file.path);
								if (!review) return;
								await editors.openEditor(review.input, {
									pinned: true, viewState: {
										revealData: { resource: { original: review.item.original.resource, modified: review.item.modified.resource } },
									}
								});
							} catch (error) {
								if (!isCancellationError(error)) notifications.error(error instanceof Error ? error : String(error));
							}
						},
					})) ?? []);
			},
		}, instantiationService, dialogs, quickInput, widgets, contextKeys, voiceOnboarding);
		const parent = this.input.element;
		const inputContainer = this.input.inputContainerElement;
		const footer = this.input.inputFooterElement;
		parent.classList.add('ash-sessions-chat-input', 'floating-card', 'chat-composer');
		const pullRequests = this._register(instantiationService.createInstance(SessionChatInputToolbar, parent, model));
		parent.insertBefore(pullRequests.domNode, inputContainer);
		pullRequests.render();
		const tipContainer = h(parent.ownerDocument, 'div', { className: 'ash-sessions-chat-tip-slot' });
		parent.insertBefore(tipContainer, inputContainer);
		this._register(toDisposable(() => tipContainer.remove()));
		this.tips = this._register(instantiationService.createInstance(ChatInputTipPresenter, {
			container: tipContainer,
			isEligible: () => !this.model.inputState.aiDisabled && !this.submittedInput && this.model.items.length === 0
				&& (this.model.inputState.phase === 'ready' || (this.model.untitledSessionId !== undefined && this.model.inputState.phase === 'loading'))
				&& !this.model.inputState.interaction,
			focusInput: () => this.input.focus(),
		}, this.input.noticeHost));
		footer.classList.add('ash-sessions-chat-input-footer');
		this.workspacePicker = this._register(instantiationService.createInstance(SessionWorkspacePicker, footer, model));
		parent.append(footer);
		refreshChatInputStack(parent);
		this.composerThreadId = model.threadId;
		this._register(model.onDidChange(() => {
			if (this.composerThreadId !== model.threadId && this.composerThreadId !== undefined) {
				this.submittedInput = false;
			}
			this.composerThreadId = model.threadId;
			this.updateComposer();
		}));
		this.updateComposer();
	}

	private updateComposer(): void {
		this.input.element.setAttribute('aria-busy', String(this.model.inputState.phase === 'loading'));
		this.input.element.classList.toggle('has-conversation', this.submittedInput || this.model.items.length > 0);
		this.tips.update();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.workspacePicker.setVisible(visible);
	}
}
