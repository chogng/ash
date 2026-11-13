import type { IAction } from '../../../../base/common/actions.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { status as announceStatus } from '../../../../base/browser/ui/aria/aria.js';
import type { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import type { ChatInputEditorOptions } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import { ChatInputPart, type ChatInputPartOptions } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import { ChatInputTipPresenter } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputTipPresenter.js';
import * as chatInputStatePersistence from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { ChatConfiguration } from '../../../../workbench/contrib/chat/common/constants.js';
import { ChatInputArtifactPill, getChatCreationHelp, type ChatCreationModel } from './chatInputArtifactPill.js';
import { SESSIONS_COMPACT_INPUT_HEIGHT } from '../common/constants.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../common/newChatDraftState.js';
import { getNativeChatAccessibilityHelp } from './nativeChatAccessibilityHelp.js';
import { getSessionArtifactsAccessibilityHelp, SessionArtifacts, type SessionArtifactSource } from './sessionArtifacts.js';
import './media/chatInput.css';
import './media/chatInputCard.css';
import './media/nativeChatInput.css';

export interface ReplyChatDraftPicker extends IDisposable {
	getAttachMenuProjectActions?(): readonly IAction[] | undefined;
}

interface ReplyChatInputOptions {
	readonly inputLabel?: string;
	readonly explicitModelSelection?: true;
	readonly literalServerCommands?: true;
	readonly useWorkbenchModelManagement?: true;
	readonly persistentDraftScope?: string;
	readonly createDraftPicker?: (footer: HTMLElement) => ReplyChatDraftPicker;
	readonly accessibilityHelp?: () => string;
}

export class ReplyChatInputFactory {
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@INotificationService private readonly notifications: INotificationService,
		@IStorageService private readonly storage: IStorageService,
		@ILifecycleService private readonly lifecycle: ILifecycleService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { }

	create(container: HTMLElement, delegate: ChatInputDelegate, model: IChatWidgetModel & SessionArtifactSource, options: ReplyChatInputOptions, owner: DisposableStore): ChatInputPart {
		let draftPicker: ReplyChatDraftPicker | undefined;
		const createDraftPicker = options.createDraftPicker;
		const input = this.createInput(container, {
			...delegate,
			selectAutomaticModel: options.explicitModelSelection ? undefined : delegate.selectAutomaticModel,
			executeServerCommand: options.literalServerCommands ? undefined : delegate.executeServerCommand,
		}, {
			placeholder: localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
			height: SESSIONS_COMPACT_INPUT_HEIGHT,
			tabFocusMode: true,
		}, {
			layout: 'compact',
			stageImages: !delegate.draft,
			useWorkbenchModelManagement: options.useWorkbenchModelManagement === true,
			configureModelInMenu: true,
			chatModelSlider: true,
			renderLeadingFooter: createDraftPicker && (footer => draftPicker = createDraftPicker(footer)),
			attachMenuHost: { getProjectActions: () => draftPicker?.getAttachMenuProjectActions?.() },
			inputLabel: options.inputLabel,
			accessibilityHelp: () => [options.accessibilityHelp?.(), getSessionArtifactsAccessibilityHelp()].filter(Boolean).join('\n'),
		});
		owner.add(this.instantiation.createInstance(SessionArtifacts, input, model));
		const draftScope = options.persistentDraftScope;
		if (draftScope) {
			this.bindDraft(input, model, identity => `${draftScope}:${identity}`);
		}
		input.composerForm.classList.add('ash-sessions-chat-input-card', 'floating-card');
		input.element.classList.add('ash-sessions-chat-input');
		return input;
	}

	createSessionInput(container: HTMLElement, delegate: ChatInputDelegate, model: IChatWidgetModel & Partial<ChatCreationModel> & SessionArtifactSource, owner: DisposableStore): ChatInputPart {
		let submitted = false;
		const input = this.createInput(container, {
			...delegate,
			executeServerCommand: undefined,
			send: async (...args) => {
				submitted = true;
				update();
				try { await delegate.send(...args); }
				catch (error) {
					if (!model.items.length) submitted = false;
					update();
					throw error;
				}
			},
		}, { placeholder: '', height: { minimum: 32, maximum: 240 } }, {
			accessibilityHelp: () => `${getNativeChatAccessibilityHelp()}\n${getChatCreationHelp()}\n${getSessionArtifactsAccessibilityHelp()}`,
			statusText: (state, _contexts, text) => !state.aiDisabled && model.untitledSessionId !== undefined && state.phase === 'loading' && !state.error ? '' : text,
		});
		owner.add(this.instantiation.createInstance(SessionArtifacts, input, model));
		const parent = input.element;
		parent.classList.add('ash-sessions-native-chat-input', 'native-chat-composer');
		input.composerForm.classList.add('ash-sessions-chat-input-card', 'floating-card', 'stacked');
		owner.add(new ChatInputArtifactPill(input, model));
		const heading = h(parent.ownerDocument, 'h2', { className: 'ash-sessions-native-chat-welcome-heading' });
		heading.textContent = localize('sessions.chat.welcome', 'What can we work on?');
		parent.prepend(heading);
		const tipContainer = h(parent.ownerDocument, 'div', { className: 'ash-sessions-native-chat-tip-slot' });
		parent.append(tipContainer);
		const tips = owner.add(this.instantiation.createInstance(ChatInputTipPresenter, {
			container: tipContainer,
			getSessionId: () => model.untitledSessionId,
			tipIds: ['attach-files'],
			isEligible: () => this.configuration.getValue<boolean>(ChatConfiguration.TipsEnabled) !== false
				&& !model.inputState.aiDisabled && !submitted && !model.items.length && !model.inputState.interaction
				&& (model.inputState.phase === 'ready' || (model.untitledSessionId !== undefined && model.inputState.phase === 'loading')),
			focusInput: () => input.focus(),
		}, input.noticeHost));
		owner.add(addDisposableListener(input.composerForm, 'focusin', event => {
			if (input.composerForm.contains(event.relatedTarget as Node | null)) return;
			const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Chat);
			if (hint) announceStatus(hint);
		}));
		this.bindDraft(input, model, identity => identity);
		const update = () => {
			const hasConversation = submitted || model.items.length > 0;
			parent.setAttribute('aria-busy', String(model.inputState.phase === 'loading'));
			parent.classList.toggle('has-conversation', hasConversation);
			heading.hidden = hasConversation;
			tips.update();
		};
		owner.add(model.onDidChangeComposer(() => { submitted = false; }));
		owner.add(model.onDidChange(update));
		owner.add(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ChatConfiguration.TipsEnabled)) tips.update();
		}));
		update();
		return input;
	}

	private createInput(container: HTMLElement, delegate: ChatInputDelegate, editor: Pick<ChatInputEditorOptions, 'placeholder' | 'height' | 'tabFocusMode'>,
		options: Omit<ChatInputPartOptions, 'modePicker' | 'modelPickerPosition' | 'renderSecondaryToolbar' | 'draftStorage'>): ChatInputPart {
		return this.instantiation.createInstance(ChatInputPart, container, delegate, this.menus, this.contextViews, this.accessibleViews, this.notifications, {
			create: (editorOptions: ChatInputEditorOptions) => this.instantiation.createInstance(ChatInputEditor, { ...editorOptions, ...editor }),
		}, [], { ...options, modePicker: 'hidden', modelPickerPosition: 'trailing', renderSecondaryToolbar: false, draftStorage: 'host' });
	}

	private bindDraft(input: ChatInputPart, model: IChatWidgetModel, key: (identity: string) => string): void {
		input.bindDraftStorage(model, {
			read: identity => readNewChatDraftState(this.storage, key(identity), chatInputStatePersistence),
			write: (identity, draft) => writeNewChatDraftState(this.storage, draft, key(identity), chatInputStatePersistence),
			flush: () => this.storage.flush(),
		}, this.lifecycle.onWillShutdown);
	}
}
