import { SessionBackgroundActivitiesControl } from './sessionBackgroundActivitiesControl.js';
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
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { ChatInputTipPresenter } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputTipPresenter.js';
import { IVoiceModeOnboardingService } from '../../../../workbench/contrib/agentsVoice/browser/voiceModeOnboarding.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import type { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { ComposerSessionControls } from './sharedChatInputComposer.contribution.js';
import { SharedChatInputComposer } from './sharedChatInputComposer.js';
import { SessionChatInputToolbar } from './sessionChatInputToolbar.js';
import { NewSessionPickersAvailableContext } from './newChatPickerKeybinding.js';
import { SessionsChatResponseFileChangesService } from './sessionTurnChanges.js';
import { refreshChatInputStack } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStack.js';
import './media/chatInput.css';
import './media/chatInputCard.css';
import '../../../common/theme.js';

interface INewChatWidgetOptions {
	readonly panelId: string;
	readonly model: ChatWidgetModel;
	readonly createNewSession: () => void;
}

/** Owns the Code chat surface and its input while retaining the shared transcript and send pipeline. */
export class NewChatWidget extends ChatWidget<ChatWidgetModel> {
	declare readonly input: ChatInputPart;
	private readonly composer: SharedChatInputComposer;
	private readonly tips: ChatInputTipPresenter;
	private readonly sessionControls: ComposerSessionControls | undefined;
	private submittedInput = false;
	private composerThreadId: string | undefined;

	constructor(
		container: HTMLElement,
		{ panelId, model, createNewSession }: INewChatWidgetOptions,
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
		@IConfigurationService configuration: IConfigurationService,
	) {
		let composer!: SharedChatInputComposer;
		const turnChanges = instantiationService.createInstance(SessionsChatResponseFileChangesService, model);
		super(container, panelId, model, createNewSession, contextMenus, contextViews, commands, accessibleViews, notifications,
			undefined, undefined, undefined,
			(inputContainer, delegate) => {
				composer = instantiationService.createInstance(SharedChatInputComposer, inputContainer, {
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
				}, model);
				return composer.input;
			}, {
			promptTimelineChanges: prompt => turnChanges.getChangesForRequest(prompt),
		}, instantiationService, dialogs, quickInput, widgets, contextKeys, voiceOnboarding);
		this.composer = this._register(composer);
		const parent = this.input.element;
		const inputContainer = this.input.composerForm;
		const footer = this.input.composerFooter!;
		parent.classList.add('ash-sessions-chat-input', 'chat-composer');
		inputContainer.classList.add('ash-sessions-chat-input-card', 'floating-card');
		const toolbar = this._register(instantiationService.createInstance(SessionChatInputToolbar, parent, () => this.input.focus()));
		parent.insertBefore(toolbar.element, inputContainer);
		const activities = this._register(instantiationService.createInstance(SessionBackgroundActivitiesControl, parent, model));
		parent.insertBefore(activities.element, inputContainer);
		const tipContainer = h(parent.ownerDocument, 'div', { className: 'ash-sessions-chat-tip-slot' });
		parent.insertBefore(tipContainer, inputContainer);
		this._register(toDisposable(() => tipContainer.remove()));
		this.tips = this._register(instantiationService.createInstance(ChatInputTipPresenter, {
			container: tipContainer,
			isEligible: () => this.visible && configuration.getValue<boolean>(ChatConfiguration.TipsEnabled) !== false
				&& !this.model.isNestedDraft && !this.model.inputState.aiDisabled && !this.submittedInput && this.model.items.length === 0
				&& (this.model.inputState.phase === 'ready' || (this.model.untitledSessionId !== undefined && this.model.inputState.phase === 'loading'))
				&& !this.model.inputState.interaction
				&& !widgets.getAllWidgets().some(widget => widget !== this && widget.visible && widget.domNode.ownerDocument === parent.ownerDocument),
			focusInput: () => this.input.focus(),
		}, this.input.noticeHost));
		this._register(widgets.onDidChangeWidgets(() => {
			if (!this.isDisposed) this.tips.update();
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.TipsEnabled)) this.tips.update();
		}));
		footer.classList.add('ash-sessions-chat-input-footer');
		if (!model.isNestedDraft) {
			this.sessionControls = this._register(instantiationService.createInstance(ComposerSessionControls, footer, model, () => this.saveState()));
		}
		this.renderDraftNotice(parent);
		parent.append(footer);
		refreshChatInputStack(parent);
		this.composerThreadId = model.threadId;
		const pickersAvailable = NewSessionPickersAvailableContext.bindTo(this.scopedContextKeys);
		const updatePickerAvailability = () => pickersAvailable.set(this.visible && !!model.untitledSessionId && !model.isNestedDraft
			&& !model.inputState.aiDisabled && model.inputState.phase !== 'submitting');
		this._register(this.onDidChangeVisibility(updatePickerAvailability));
		this._register(model.onDidChange(() => {
			updatePickerAvailability();
			if (this.composerThreadId !== model.threadId && this.composerThreadId !== undefined) {
				this.submittedInput = false;
			}
			this.composerThreadId = model.threadId;
			this.updateComposer();
		}));
		updatePickerAvailability();
		this.updateComposer();
	}

	protected renderDraftNotice(_container: HTMLElement): void { }

	saveState(): Promise<void> {
		return this.composer.saveState();
	}

	focusWorkspacePicker(): void {
		this.sessionControls?.open('workspace');
	}

	focusEnvironmentPicker(): void {
		this.sessionControls?.open('environment');
	}

	private updateComposer(): void {
		this.input.element.setAttribute('aria-busy', String(this.model.inputState.phase === 'loading'));
		this.input.element.classList.toggle('has-conversation', this.submittedInput || this.model.items.length > 0);
		this.tips.update();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.sessionControls?.setVisible(visible);
	}
}
