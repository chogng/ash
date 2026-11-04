import type { IDimension } from '../../../../base/browser/dom.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { autorun, observableFromEvent, observableValue } from '../../../../base/common/observable.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ChatWidget } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ChatInputEditorOptions } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { NEW_CHAT_WITH_MODEL_COMMAND, NEW_SESSION_WELCOME_MESSAGES_SETTING, NEW_SESSION_WELCOME_NAME_SETTING, NEW_SESSION_WELCOME_PHRASES_SETTING, SESSIONS_COMPACT_INPUT_HEIGHT } from '../../chat/common/constants.js';
import { getNewSessionWelcomePhrases, type INewSessionWelcomeMessagesConfiguration } from '../../chat/common/welcomePhrases.js';
import { IChatGPTService, selectedChatConversationId } from './chatGPTService.js';
import { ChatGPTWidgetModel } from './chatGPTWidgetModel.js';
import '../../chat/browser/media/chatInput.css';
import '../../chat/browser/media/chatInputCard.css';
import '../../chat/browser/media/chatView.css';
import { chatGPTScrollOptimization } from './chatGPTWeb.js';

export class ChatGPTEditorPane extends EditorPane {
	public readonly id = 'sessions.editor.chatgpt';
	private widget!: ChatWidget<ChatGPTWidgetModel>;
	private readonly shown = observableValue(this, false);
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IChatGPTService private readonly chat: IChatGPTService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@ICommandService private readonly commands: ICommandService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@INotificationService private readonly notifications: INotificationService,
		@IOpenerService private readonly opener: IOpenerService,
		@IEditorService private readonly editors: IEditorService,
		@IThemeService theme: IThemeService,
		@IStorageService private readonly profileStorage: IStorageService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) { super('sessions.editor.chatgpt', theme, profileStorage); }
	public override create(parent: HTMLElement): void {
		const root = parent.ownerDocument.createElement('section');
		root.className = 'ash-chatgpt-widget ash-sessions-chat-content';
		root.style.height = '100%';
		root.setAttribute('aria-label', localize('sessions.chatgpt.title', 'ChatGPT'));
		parent.append(root);
		super.create(root);
		const contextKeys = this._register(this.contextKeys.createScoped(root));
		contextKeys.createKey('chatGPTFocused', true);
		// Nested input editors must inherit this page's accessibility context.
		const instantiation = this._register(this.instantiation.createChild(new ServiceCollection([IContextKeyService, contextKeys])));
		const model = instantiation.createInstance(ChatGPTWidgetModel);
		try {
			this.widget = this._register(instantiation.createInstance(ChatWidget<ChatGPTWidgetModel>,
				root, 'sessions-chat-reply', model, () => this.chat.newChat(),
				this.menus, this.contextViews, this.commands, this.accessibleViews, this.notifications,
				this.opener, this.editors, undefined,
				(container: HTMLElement, delegate: ChatInputDelegate) => {
					const input = instantiation.createInstance(ChatInputPart, container, delegate,
						this.menus, this.contextViews, this.accessibleViews, this.notifications, {
						create: (options: ChatInputEditorOptions) => instantiation.createInstance(ChatInputEditor, {
							...options,
							placeholder: localize('sessions.chat.inputPlaceholder', 'Describe a task or ask a question'),
							height: SESSIONS_COMPACT_INPUT_HEIGHT,
							tabFocusMode: true,
						}),
					}, [], {
						layout: 'compact', modePicker: 'hidden', modelPickerPosition: 'trailing',
						renderSecondaryToolbar: false, draftStorage: 'host',
						inputLabel: localize('sessions.chatgpt.prompt', 'Ask ChatGPT'),
						alternateModelAction: CommandsRegistry.hasCommand(NEW_CHAT_WITH_MODEL_COMMAND) ? {
							id: NEW_CHAT_WITH_MODEL_COMMAND,
							label: localize('sessions.newChatModel.useAsh', 'New Ash Chat with Model…'),
							tooltip: '', enabled: true,
							run: () => {
								const state = this.chat.state.get();
								const text = selectedChatConversationId(state) || state.pendingCreation || state.messages.length ? undefined : state.draft;
								return this.commands.executeCommand(NEW_CHAT_WITH_MODEL_COMMAND, { source: 'chatgpt', text });
							},
						} : undefined,
					});
					input.element.classList.add('ash-sessions-chat-input', 'chat-composer');
					input.composerForm.classList.add('ash-sessions-chat-input-card', 'floating-card');
					return input;
				}, { showPromptTimeline: true, welcomeTitle: this.createWelcomeTitle() }));
		} catch (error) {
			model.dispose();
			throw error;
		}
		const update = (): void => { root.classList.toggle('ash-chat-defer-completed', this.configuration.getValue<boolean>(chatGPTScrollOptimization)); };
		update();
		this._register(this.configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(chatGPTScrollOptimization)) { update(); } }));
		this._register(addDisposableListener(root, 'focusin', event => {
			if (!root.contains(event.relatedTarget as Node) && this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.ChatGPT)) {
				status(localize('sessions.chatgpt.navigationHint', 'Press Alt+F1 for ChatGPT accessibility help.'));
			}
		}));
	}
	public override async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> { }
	public override clearInput(): void { }
	public override layout(_dimension: IDimension): void { }
	public override focus(): void { this.widget.focus(); }
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.widget?.setVisible(visible);
		this.shown.set(visible, undefined);
	}

	private createWelcomeTitle() {
		const title = observableValue<string | undefined>(this, undefined);
		const enabled = observableConfigValue(NEW_SESSION_WELCOME_PHRASES_SETTING, true, this.configuration);
		const name = observableConfigValue(NEW_SESSION_WELCOME_NAME_SETTING, '', this.configuration);
		const messages = observableConfigValue<INewSessionWelcomeMessagesConfiguration | undefined>(NEW_SESSION_WELCOME_MESSAGES_SETTING, undefined, this.configuration);
		const verbosityKey = 'accessibility.verbosity.newSessionWelcome';
		const verbosity = observableConfigValue(verbosityKey, true, this.configuration);
		const screenReader = observableFromEvent(this, this.accessibility.onDidChangeScreenReaderOptimized, () => this.accessibility.isScreenReaderOptimized());
		let identity: string | undefined;
		let draftRevision = -1;
		let index = 0;
		let announced = false;
		this._register(autorun(reader => {
			const state = this.chat.state.read(reader);
			const isNew = !state.conversationId && !state.coworkTasks.length && !state.messages.length && state.loading?.kind !== 'conversation';
			if (isNew && (identity !== state.localConversationId || draftRevision !== this.chat.newDraftRevision)) {
				identity = state.localConversationId;
				draftRevision = this.chat.newDraftRevision;
				announced = false;
				const key = 'agentSessions.newSession.welcomePhraseIndex';
				const stored = this.profileStorage.getNumber(key, StorageScope.PROFILE, 0);
				index = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
				this.profileStorage.store(key, index < Number.MAX_SAFE_INTEGER - 1 ? index + 1 : 0, StorageScope.PROFILE, StorageTarget.MACHINE);
			}
			const phrases = getNewSessionWelcomePhrases(messages.read(reader), name.read(reader).trim() || undefined);
			const phrase = isNew && enabled.read(reader) && phrases.length ? phrases[index % phrases.length] : undefined;
			title.set(phrase, undefined);
			if (this.shown.read(reader) && phrase && !announced && screenReader.read(reader) && verbosity.read(reader)) {
				announced = true;
				this.accessibility.status(localize('newSession.welcome.announcement', '{0}\nTo disable this announcement, set {1} to false.', phrase, verbosityKey));
			}
		}));
		return title;
	}
}
