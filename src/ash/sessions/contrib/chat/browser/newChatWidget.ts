import { SessionBackgroundActivitiesControl } from './sessionBackgroundActivitiesControl.js';
import { h } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableFromEvent, observableValue, type IObservable, type IReader } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IChatWidgetService, type ChatMessagePresentation } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatWidgetModel } from '../../../browser/chatWidgetModel.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ChatInputTipPresenter } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputTipPresenter.js';
import { IVoiceModeOnboardingService } from '../../../../workbench/contrib/agentsVoice/browser/voiceModeOnboarding.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import type { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { BackgroundSendAvailableContext, ComposerSessionControls } from './sharedChatInputComposer.contribution.js';
import { SharedChatInputComposer } from './sharedChatInputComposer.js';
import { ChatWelcomeTitle } from './chatWelcomeTitle.js';
import { ASH_CHAT_SELECTED_CONTEXT, CODE_HISTORY_VIRTUALIZE_FROM } from '../common/constants.js';
import { SessionChatInputToolbar } from './sessionChatInputToolbar.js';
import { NewSessionPickersAvailableContext } from './newChatPickerKeybinding.js';
import { SessionsChatResponseFileChangesService } from './sessionTurnChanges.js';
import { refreshChatInputStack } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStack.js';
import { resolveChatContextAttachment } from '../../../../workbench/services/chat/common/chatContextService.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ChatInputArtifactPill } from '../../artifacts/browser/chatInputArtifactPill.js';
import './media/chatInput.css';
import './media/chatInputCard.css';
import './media/newChatEnvironment.css';
import '../../../common/theme.js';

interface INewChatWidgetOptions {
	readonly panelId: string;
	readonly model: ChatWidgetModel;
	readonly createNewSession: () => void;
	readonly messagePresentation?: ChatMessagePresentation;
}

/** Owns the native conversation and projects its composer for the active workspace. */
export class NewChatWidget extends ChatWidget<ChatWidgetModel> {
	declare readonly input: ChatInputPart;
	private readonly composer: SharedChatInputComposer;
	private readonly tips: ChatInputTipPresenter;
	private readonly sessionControls: ComposerSessionControls | undefined;
	private readonly environmentSetup: HTMLElement | undefined;
	private readonly codePresentation: IObservable<boolean>;
	private submittedInput = false;
	private composerThreadId: string | undefined;

	constructor(
		container: HTMLElement,
		{ panelId, model, createNewSession, messagePresentation }: INewChatWidgetOptions,
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
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
		@IEditorService editors: IEditorService,
	) {
		let composer!: SharedChatInputComposer;
		const turnChanges = instantiationService.createInstance(SessionsChatResponseFileChangesService, model);
		const chatPresentation = observableFromEvent('native Chat presentation', contextKeys.onDidChangeContext,
			() => contextKeys.getValue(ASH_CHAT_SELECTED_CONTEXT) === true);
		const codePresentation = observableFromEvent('Code presentation', contextKeys.onDidChangeContext,
			() => contextKeys.getValue(SessionsWorkspaceModeContext.key) === 'code');
		const welcomeTitle = observableValue<string | null | undefined>('native chat welcome', undefined);
		super(container, panelId, model, createNewSession, contextMenus, contextViews, commands, accessibleViews, notifications,
			undefined, editors, undefined,
			(inputContainer, delegate) => {
				const sendInBackground: NonNullable<ChatInputDelegate['sendInBackground']> = async (text, mode, skills, contexts, signal) => {
					const resolved = await Promise.all(contexts.map(resolveChatContextAttachment));
					const active = await model.sendInBackground(text, mode, skills, resolved, signal);
					if (!active || this.isDisposed) return;
					notifications.notify({
						severity: Severity.Info,
						message: localize('sessions.chat.backgroundSend.sent', 'Message sent in the background.'),
						actions: {
							primary: [{
								id: 'sessions.openBackgroundSession',
								label: localize('sessions.chat.backgroundSend.open', 'Open Session'),
								tooltip: '',
								enabled: true,
								run: () => navigation.openConversation(active.session.sessionId, active.threadId),
							}],
						},
					});
				};
				composer = instantiationService.createInstance(SharedChatInputComposer, inputContainer, {
					...delegate,
					get sendInBackground() { return model.untitledSessionId && !model.isNestedDraft ? sendInBackground : undefined; },
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
				}, model, chatPresentation, () => this.focusWorkspacePicker());
				return composer.input;
			}, {
			promptTimelineChanges: prompt => turnChanges.getChangesForRequest(prompt),
			getTurnChanges: source => turnChanges.getChangesForResponse(source),
			messagePresentation,
			virtualizeHistoryFrom: codePresentation.map(code => code ? CODE_HISTORY_VIRTUALIZE_FROM : undefined),
			welcomeTitle,
		}, instantiationService, dialogs, quickInput, widgets, contextKeys, voiceOnboarding, configuration);
		this.composer = this._register(composer);
		this.codePresentation = codePresentation;
		const shown = observableFromEvent(this, this.onDidChangeVisibility, () => this.visible);
		const draftId = observableFromEvent(this, model.onDidChange, () => model.welcomeDraftId);
		const welcome = this._register(instantiationService.createInstance(ChatWelcomeTitle, (reader: IReader) => {
			const id = chatPresentation.read(reader) && draftId.read(reader);
			return id ? { id, revision: 0 } : undefined;
		}, shown, false));
		this._register(autorun(reader => {
			const showEnvironment = codePresentation.read(reader) && !model.isNestedDraft;
			welcomeTitle.set(chatPresentation.read(reader) ? welcome.title.read(reader) : showEnvironment ? null : undefined, undefined);
		}));
		const parent = this.input.element;
		const inputContainer = this.input.composerForm;
		const footer = this.input.composerFooter!;
		parent.classList.add('ash-sessions-chat-input', 'chat-composer');
		inputContainer.classList.add('ash-sessions-chat-input-card', 'floating-card');
		const toolbar = this._register(instantiationService.createInstance(SessionChatInputToolbar, parent, () => this.input.focus(), model));
		toolbar.setVisible(this.visible);
		this._register(this.onDidChangeVisibility(() => toolbar.setVisible(this.visible)));
		parent.insertBefore(toolbar.element, inputContainer);
		const activities = this._register(instantiationService.createInstance(SessionBackgroundActivitiesControl, parent, model));
		parent.insertBefore(activities.element, inputContainer);
		const tipAnchor = h(parent.ownerDocument, 'div', { className: 'ash-sessions-chat-tip-anchor' });
		const tipContainer = h(parent.ownerDocument, 'div', { className: 'ash-sessions-chat-tip-slot' });
		tipAnchor.append(tipContainer);
		parent.insertBefore(tipAnchor, inputContainer);
		this._register(toDisposable(() => tipAnchor.remove()));
		this.tips = this._register(instantiationService.createInstance(ChatInputTipPresenter, {
			container: tipContainer,
			getSessionId: () => model.untitledSessionId,
			isEligible: () => this.visible && configuration.getValue<boolean>(ChatConfiguration.TipsEnabled) !== false
				&& !chatPresentation.get() && !this.model.isNestedDraft && !this.model.inputState.aiDisabled && !this.submittedInput && this.model.items.length === 0
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
			this.environmentSetup = h(parent.ownerDocument, 'div', { className: 'ash-sessions-environment-setup' });
			parent.before(this.environmentSetup);
			this._register(toDisposable(() => this.environmentSetup?.remove()));
			this.sessionControls = this._register(instantiationService.createInstance(ComposerSessionControls, footer, this.environmentSetup, model, () => this.saveState()));
			const { setupCard } = this.sessionControls;
			// Keep the tip measurable so it can return when the window has room again.
			this._register(observeResize([this.environmentSetup, setupCard, tipContainer], () => {
				const tip = tipContainer.getBoundingClientRect();
				const card = setupCard.getBoundingClientRect();
				const overlaps = tip.height > 0 && card.height > 0 && tip.top < card.bottom;
				if (overlaps && tipContainer.contains(parent.ownerDocument.activeElement)) this.input.focus();
				tipContainer.inert = overlaps;
			}));
		}
		this._register(new ChatInputArtifactPill(this.input, model));
		this.renderDraftNotice(parent);
		parent.append(footer);
		this.input.useResponsiveFooter(() => this.sessionControls?.responsivePickers ?? []);
		refreshChatInputStack(parent);
		this.composerThreadId = model.threadId;
		const pickersAvailable = NewSessionPickersAvailableContext.bindTo(this.scopedContextKeys);
		const backgroundSendAvailable = BackgroundSendAvailableContext.bindTo(this.scopedContextKeys);
		const updatePickerAvailability = () => {
			const available = this.visible && !!model.untitledSessionId && !model.isNestedDraft
				&& !model.inputState.aiDisabled && model.inputState.phase !== 'submitting';
			pickersAvailable.set(available);
			backgroundSendAvailable.set(available && !model.inputState.inputBlocked);
		};
		this._register(this.onDidChangeVisibility(updatePickerAvailability));
		this._register(autorun(reader => {
			chatPresentation.read(reader);
			codePresentation.read(reader);
			this.updateComposer();
		}));
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
		const hasConversation = this.submittedInput || this.model.items.length > 0;
		if (this.environmentSetup) this.environmentSetup.hidden = !this.codePresentation.get() || hasConversation || !this.model.untitledSessionId || this.model.inputState.aiDisabled === true;
		this.input.element.setAttribute('aria-busy', String(this.model.inputState.phase === 'loading'));
		this.input.element.classList.toggle('has-conversation', hasConversation);
		this.tips.update();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.sessionControls?.setVisible(visible);
	}
}
