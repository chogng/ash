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
import { NewChatInputWidget } from './newChatInput.js';
import { SessionChatInputToolbar } from './sessionChatInputToolbar.js';
import { NewSessionPickersAvailableContext } from './newChatPickerKeybinding.js';
import { SessionsChatResponseFileChangesService } from './sessionTurnChanges.js';
import { SessionEnvironmentPicker } from './sessionEnvironmentPicker.js';
import { SessionWorkspacePicker } from './sessionWorkspacePicker.js';
import { refreshChatInputStack } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStack.js';
import './media/chatInput.css';
import '../../../common/theme.js';

/** Owns the Code chat surface and its input while retaining the shared transcript and send pipeline. */
export class NewChatWidget extends ChatWidget<ChatWidgetModel> {
	declare readonly input: NewChatInputWidget;
	private readonly tips: ChatInputTipPresenter;
	private readonly environmentPicker: SessionEnvironmentPicker | undefined;
	private readonly workspacePicker: SessionWorkspacePicker | undefined;
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
		@IConfigurationService configuration: IConfigurationService,
	) {
		const turnChanges = instantiationService.createInstance(SessionsChatResponseFileChangesService, model);
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
			promptTimelineFiles: prompt => turnChanges.getChangesForRequest(prompt),
		}, instantiationService, dialogs, quickInput, widgets, contextKeys, voiceOnboarding);
		const parent = this.input.element;
		const inputContainer = this.input.inputContainerElement;
		const footer = this.input.inputFooterElement;
		parent.classList.add('ash-sessions-chat-input', 'floating-card', 'chat-composer');
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
			this.workspacePicker = this._register(instantiationService.createInstance(SessionWorkspacePicker, footer, model));
			this.environmentPicker = this._register(instantiationService.createInstance(SessionEnvironmentPicker, footer, model, () => this.input.persistDraftForHostChange()));
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

	focusWorkspacePicker(): void {
		if (this.visible) { this.workspacePicker?.showPicker(); }
	}

	focusEnvironmentPicker(): void {
		if (this.visible) { this.environmentPicker?.showPicker(); }
	}

	private updateComposer(): void {
		this.input.element.setAttribute('aria-busy', String(this.model.inputState.phase === 'loading'));
		this.input.element.classList.toggle('has-conversation', this.submittedInput || this.model.items.length > 0);
		this.tips.update();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.workspacePicker?.setVisible(visible);
		this.environmentPicker?.setVisible(visible);
	}
}
