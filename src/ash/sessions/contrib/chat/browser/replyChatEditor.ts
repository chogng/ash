import { Button } from '../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IChatListCatalog } from './chatListModel.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { autorun, observableFromEvent, observableValue, type IObservable, type IReader } from '../../../../base/common/observable.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../nls.js';
import { IAccessibleViewService, type AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPane, EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ChatWidget, type IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import { ChatInputEditor } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditor.js';
import { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ChatInputEditorOptions } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputEditorRegistry.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { NEW_SESSION_WELCOME_MESSAGES_SETTING, NEW_SESSION_WELCOME_NAME_SETTING, NEW_SESSION_WELCOME_PHRASES_SETTING, SESSIONS_COMPACT_INPUT_HEIGHT } from '../common/constants.js';
import { getNewSessionWelcomePhrases, type INewSessionWelcomeMessagesConfiguration } from '../common/welcomePhrases.js';
import './media/chatInput.css';
import './media/chatInputCard.css';
import './media/chatView.css';

export interface IReplyChatEditorModel extends IChatWidgetModel {
	newChat(): void;
	readWelcomeDraft(reader: IReader): { readonly id: string; readonly revision: number; } | undefined;
}

export interface ReplyChatEditorOptions {
	readonly id: string;
	readonly scheme: string;
	readonly name: string;
	readonly rootClass: string;
	readonly title: () => string;
	readonly inputLabel: () => string;
	readonly model: SyncDescriptor<IReplyChatEditorModel>;
	readonly createDraftPicker?: (instantiation: IInstantiationService, footer: HTMLElement, visible: IObservable<boolean>) => IDisposable;
	readonly accessibility: {
		readonly focusContext: string;
		readonly verbositySetting: AccessibilityVerbositySettingId;
		readonly hint: () => string;
	};
	readonly scrollOptimizationSetting: string;
}

export function registerReplyChatEditor(options: ReplyChatEditorOptions): void {
	registerEditorPane({
		id: options.id,
		name: options.name,
		canOpen: input => input.resource.scheme === options.scheme ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: context => context.instantiationService!.createInstance(ReplyChatEditor, options),
	});
}

/** Owns the compact Sessions editor and consumes the selected reply provider's model. */
export class ReplyChatEditor extends EditorPane {
	readonly id: string;
	private widget: ChatWidget<IReplyChatEditorModel> | undefined;
	private readonly shown = observableValue(this, false);
	constructor(
		private readonly options: ReplyChatEditorOptions,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
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
		@IChatListCatalog private readonly chatCatalog: IChatListCatalog,
	) {
		super(options.id, theme, profileStorage);
		this.id = options.id;
	}
	public override create(parent: HTMLElement): void {
		const root = h(parent.ownerDocument, 'section', {
			className: `${this.options.rootClass} ash-reply-chat-editor ash-sessions-chat-content ash-chat-content-layout`,
			attributes: { 'aria-label': this.options.title() },
		});
		root.style.height = '100%';
		parent.append(root);
		super.create(root);
		const contextKeys = this._register(this.contextKeys.createScoped(root));
		contextKeys.createKey(this.options.accessibility.focusContext, true);
		// Nested input editors must inherit this page's accessibility context.
		const instantiation = this._register(this.instantiation.createChild(new ServiceCollection([IContextKeyService, contextKeys])));
		const model = instantiation.createInstance(this.options.model);
		const projectLink = h(parent.ownerDocument, 'div', { className: 'ash-reply-chat-project' });
		projectLink.hidden = true;
		root.append(projectLink);
		let projectId: string | undefined;
		const projectButton = this._register(new Button(projectLink, {
			...defaultButtonStyles, label: '', icon: Lxicon.projects, presentation: 'quiet',
			onClick: () => {
				if (!projectId) return;
				void this.commands.executeCommand('sessions.open.projects', projectId)
					.catch(error => this.notifications.error(toErrorMessage(error)));
			},
		}));
		this._register(autorun(reader => {
			const snapshots = this.chatCatalog.sources.map(source => source.snapshot.read(reader));
			const entry = snapshots.flatMap(snapshot => snapshot.entries).find(entry => entry.selected);
			const project = entry?.projectId && snapshots.flatMap(snapshot => snapshot.projects ?? [])
				.find(project => project.id === entry.projectId && !project.archived);
			projectId = project ? project.id : undefined;
			projectButton.label = project ? project.title : '';
			projectLink.hidden = !project;
		}));
		const createDraftPicker = this.options.createDraftPicker;
		try {
			this.widget = this._register(instantiation.createInstance(ChatWidget<IReplyChatEditorModel>,
				root, 'sessions-chat-reply', model, () => model.newChat(),
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
						useWorkbenchModelManagement: false,
						renderSecondaryToolbar: false, draftStorage: 'host',
						renderLeadingFooter: createDraftPicker && ((footer: HTMLElement) => createDraftPicker(instantiation, footer, this.shown)),
						inputLabel: this.options.inputLabel(),
					});
					input.element.classList.add('ash-sessions-chat-input', 'chat-composer');
					input.composerForm.classList.add('ash-sessions-chat-input-card', 'floating-card');
					return input;
				}, { showPromptTimeline: true, welcomeTitle: this.createWelcomeTitle(model) }));
		} catch (error) {
			model.dispose();
			throw error;
		}
		const scrollOptimization = observableConfigValue(this.options.scrollOptimizationSetting, false, this.configuration);
		this._register(autorun(reader => {
			root.classList.toggle('ash-chat-defer-completed', scrollOptimization.read(reader));
		}));
		this._register(addDisposableListener(root, 'focusin', event => {
			const { hint, verbositySetting } = this.options.accessibility;
			if (!root.contains(event.relatedTarget as Node) && this.configuration.getValue<boolean>(verbositySetting)) {
				status(hint());
			}
		}));
	}
	public override async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> { }
	public override clearInput(): void { }
	public override layout(_dimension: IDimension): void { }
	public override focus(): void { this.widget?.focus(); }
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.widget?.setVisible(visible);
		this.shown.set(visible, undefined);
	}

	private createWelcomeTitle(model: IReplyChatEditorModel) {
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
			const draft = model.readWelcomeDraft(reader);
			if (draft && (identity !== draft.id || draftRevision !== draft.revision)) {
				identity = draft.id;
				draftRevision = draft.revision;
				announced = false;
				const key = 'agentSessions.newSession.welcomePhraseIndex';
				const stored = this.profileStorage.getNumber(key, StorageScope.PROFILE, 0);
				index = Number.isSafeInteger(stored) && stored >= 0 ? stored : 0;
				this.profileStorage.store(key, index < Number.MAX_SAFE_INTEGER - 1 ? index + 1 : 0, StorageScope.PROFILE, StorageTarget.MACHINE);
			}
			const phrases = getNewSessionWelcomePhrases(messages.read(reader), name.read(reader).trim() || undefined);
			const phrase = draft && enabled.read(reader) && phrases.length ? phrases[index % phrases.length] : undefined;
			title.set(phrase, undefined);
			if (this.shown.read(reader) && phrase && !announced && screenReader.read(reader) && verbosity.read(reader)) {
				announced = true;
				this.accessibility.status(localize('newSession.welcome.announcement', '{0}\nTo disable this announcement, set {1} to false.', phrase, verbosityKey));
			}
		}));
		return title;
	}
}
