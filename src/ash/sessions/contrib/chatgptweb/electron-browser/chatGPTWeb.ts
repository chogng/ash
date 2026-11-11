import { mainWindow } from '../../../../base/browser/window.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatGPTNativeTransport, type IChatGPTTransport } from '../common/chatGPTTransport.js';
import { experimentalChatGPTSelected, SHOW_EXPERIMENTAL_CHATGPT } from '../common/chatGPTNative.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { derived, type IObservable } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IChatWidgetService } from '../../../../workbench/contrib/chat/browser/chat.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import type { ModelRef } from '../../../../platform/models/common/agentModels.js';
import { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';
import { CHAT_WORKSPACE_LAST_BACKEND_KEY, CHAT_WORKSPACE_NAVIGATION_ID } from '../../chat/common/constants.js';
import type { ChatDraftModelSource } from '../../chat/browser/replyChatEditor.js';
import type { IReplyChatEditorModel, ReplyChatEditorOptions } from '../../chat/browser/replyChatEditor.js';
import { chatGPTModelEntries, ChatGPTWidgetModel } from './chatGPTWidgetModel.js';
import { ChatGPTProjectFolderPicker } from './chatGPTProjectFolderPicker.js';
import { IChatGPTNativeService, IChatGPTService, isChatGPTNewDraft } from '../browser/chatGPTService.js';
import { ISessionsSearchService } from '../../search/browser/searchService.js';
import type { SearchResult } from '../../search/browser/searchModel.js';

export const SESSIONS_CHATGPT_DEFAULT_BACKEND = 'sessions.chatgpt.defaultBackend';
export const chatGPTScrollOptimization = 'sessions.chatgpt.optimizeScrolling';
export const SHOW_CHATGPT_COMMAND = 'sessions.show.chatgpt';
export const SHOW_PREFERRED_CHATGPT_COMMAND = 'sessions.show.preferredChatgpt';

export const chatGPTReplyEditor = {
	id: 'sessions.editor.chatgpt',
	scheme: 'ash-chatgpt',
	name: 'ChatGPT',
	rootClass: 'ash-chatgpt-widget',
	title: () => localize('sessions.chatgpt.title', 'ChatGPT'),
	inputLabel: () => localize('sessions.chatgpt.prompt', 'Ask ChatGPT'),
	model: new SyncDescriptor(ChatGPTWidgetModel),
	createDraftPicker: (instantiation, footer, visible) => instantiation.createInstance(ChatGPTProjectFolderPicker, footer, visible),
	accessibility: {
		focusContext: 'chatGPTFocused',
		verbositySetting: AccessibilityVerbositySettingId.ChatGPT,
		hint: () => localize('sessions.chatgpt.navigationHint', 'Press Alt+F1 for ChatGPT accessibility help.'),
	},
	scrollOptimizationSetting: chatGPTScrollOptimization,
} satisfies ReplyChatEditorOptions;
export const chatGPTSelectedContext = 'sessions.activity.chatgptSelected';

export const experimentalChatGPTEditor = {
	...chatGPTReplyEditor,
	id: 'sessions.editor.experimentalChatgpt',
	scheme: 'ash-experimental-chatgpt',
	name: 'ChatGPT (Experimental)',
	title: () => localize('sessions.chatgpt.experimentalTitle', 'ChatGPT (Experimental)'),
	inputLabel: () => localize('sessions.chatgpt.experimentalPrompt', 'Ask ChatGPT (Experimental)'),
	scopedServices: accessor => new ServiceCollection([IChatGPTService, accessor.get(IChatGPTNativeService)]),
	accessibility: { ...chatGPTReplyEditor.accessibility, focusContext: 'experimentalChatGPTFocused' },
} satisfies ReplyChatEditorOptions;


export class ChatGPTDraftModelSource implements ChatDraftModelSource {
	readonly models: IObservable<readonly ModelCatalogEntry[]>;
	private selecting = false;

	constructor(
		@IChatGPTService private readonly chat: IChatGPTService,
		@IChatWidgetService private readonly widgets: IChatWidgetService,
		@ICommandService private readonly commands: ICommandService,
	) {
		this.models = chatGPTModelEntries(chat);
	}

	initialize(): void { this.chat.initialize(); }

	async selectModel(model: ModelRef, source: IReplyChatEditorModel): Promise<void> {
		const widget = this.widgets.getAllWidgets().find(candidate => candidate.visible && candidate.model === source);
		const draftId = source.untitledSessionId;
		const generation = source.composerGeneration;
		if (!widget || !draftId || this.selecting) return;
		this.selecting = true;
		try {
			const capture = await widget.input.captureDraft();
			if (!widget.visible || widget.input.isSubmitting || source.untitledSessionId !== draftId || source.composerGeneration !== generation
				|| source.inputState.aiDisabled || source.inputState.canSelectModel === false) return;
			if (capture?.draft.contexts.length) {
				throw new Error(localize('sessions.chatgpt.switchModelWithAttachments', 'Remove attachments before switching this draft to a ChatGPT model.'));
			}
			const state = this.chat.state.get();
			if (state.busy || state.sending || state.managing || state.voice !== 'idle'
				|| !this.models.get().some(entry => modelRefIdentity(entry.model) === modelRefIdentity(model))) {
				throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
			}
			this.chat.newChat();
			this.chat.setModel(model.model);
			const destination = this.chat.state.get();
			if (!isChatGPTNewDraft(destination) || destination.model !== model.model) {
				throw new Error(localize('sessions.newChatModel.unavailable', 'The selected model is no longer available.'));
			}
			// Each source owns its draft. Use Ash's text only when the destination has no draft content.
			if (!destination.draft && !destination.attachments.length && !destination.draftTarget) {
				if (capture) this.chat.setDraft(capture.draft.text);
				if (source.artifactDraftKind) this.chat.setDraftArtifactKind(source.artifactDraftKind);
			}
			await this.commands.executeCommand(SHOW_CHATGPT_COMMAND);
		} finally {
			this.selecting = false;
		}
	}
}

export class ChatGPTWebContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'sessions.chatgpt.web';
	constructor(
		@ISessionsEntryService layout: ISessionsEntryService,
		@IChatGPTService chat: IChatGPTService,
		@ISessionsSearchService search: ISessionsSearchService,
		@IEditorService editors: IEditorService,
		@IStorageService storage: IStorageService,
	) {
		super();
		const newDraft = chat.state.map(isChatGPTNewDraft);
		const showChat = async (source?: unknown, create?: unknown) => {
			chat.setNetworkAvailable(mainWindow?.navigator.onLine ?? true);
			if (create === true && source !== 'restore') { chat.newChat(source === 'startup' ? { clearDraft: true } : undefined); }
			chat.initialize();
			await layout.openEntry({
				id: 'chatgpt', activityContext: chatGPTSelectedContext, content: 'editor',
				sidebarContainerId: CHAT_WORKSPACE_NAVIGATION_ID, showEditorTabs: false,
				editorInput: {
					resource: URI.from({ scheme: chatGPTReplyEditor.scheme, path: '/page' }), label: chatGPTReplyEditor.title(),
					showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
				},
				restoreCommand: SHOW_CHATGPT_COMMAND, newSessionCommand: 'sessions.open.new', newDraft, focus: 'editor',
			}, undefined, source === 'restore' || source === 'startup' ? { source } : undefined);
			storage.store(CHAT_WORKSPACE_LAST_BACKEND_KEY, 'chatgpt', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		};
		this._register(search.registerSource(derived<readonly SearchResult[]>(reader => {
			const state = chat.state.read(reader);
			return state.conversations.map(conversation => ({
				id: `chatgpt:${conversation.id}`, category: 'sessions', title: conversation.title,
				description: ['ChatGPT', state.projects.find(project => project.id === conversation.projectId)?.title].filter(Boolean).join(' · '),
				icon: Lxicon.openai,
				target: {
					kind: 'contributed',
					open: async () => {
						await showChat();
						await chat.select(conversation.id);
						editors.focusActiveEditor();
					},
				},
			}));
		})));
		const newChat = () => {
			chat.newChat();
			editors.focusActiveEditor();
		};
		this._register(CommandsRegistry.register('sessions.chatgpt.newChat', newChat));
		this._register(CommandsRegistry.register(SHOW_CHATGPT_COMMAND, (_accessor, source, create) => showChat(source, create)));
		this._register(CommandsRegistry.register(SHOW_PREFERRED_CHATGPT_COMMAND, (accessor, source, create) => {
			const setting = accessor.get(IConfigurationService).getValue<string>(SESSIONS_CHATGPT_DEFAULT_BACKEND);
			const command = setting === 'chatgptweb' ? SHOW_CHATGPT_COMMAND : SHOW_EXPERIMENTAL_CHATGPT;
			return accessor.get(ICommandService).executeCommand(command, source, create === true);
		}));
		// Saved window entries and existing keybindings from the experiment retain the same chat owner.
		this._register(CommandsRegistry.register('sessions.chatgptNative.newChat', newChat));
		for (const command of ['sessions.show.chatgptNative', 'sessions.open.chatgptNative']) {
			this._register(CommandsRegistry.register(command, (_accessor, source) => showChat(source)));
		}
	}
}

export class ChatGPTExperimentalContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.chatgpt.experimental';

	constructor(
		@ISessionsEntryService layout: ISessionsEntryService,
		@IChatGPTNativeService chat: IChatGPTService,
		@IChatGPTNativeTransport transport: IChatGPTTransport,
		@IEditorService editors: IEditorService,
		@IStorageService storage: IStorageService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const newDraft = chat.state.map(isChatGPTNewDraft);
		const newChatCommand = 'sessions.experimentalChatgpt.newChat';
		const connect = async (): Promise<boolean> => {
			try {
				const signedIn = !!await transport.getCacheScope();
				if (this.isDisposed) return false;
				if (signedIn) {
					chat.initialize();
				} else {
					notifications.info(localize('sessions.chatgpt.experimentalLoginRequired', 'Sign in to Codex, then open ChatGPT (Experimental) again.'));
				}
				return signedIn;
			} catch {
				if (!this.isDisposed) notifications.error(localize('sessions.chatgpt.experimentalLoginUnavailable', 'Could not check the Codex login for ChatGPT (Experimental). Try again.'));
				return false;
			}
		};
		this._register(CommandsRegistry.register(SHOW_EXPERIMENTAL_CHATGPT, async (_accessor, source, create) => {
			chat.setNetworkAvailable(mainWindow?.navigator.onLine ?? true);
			if (create === true && source !== 'restore') { chat.newChat(source === 'startup' ? { clearDraft: true } : undefined); }
			await layout.openEntry({
				id: 'chatgpt-experimental', activityContext: experimentalChatGPTSelected, content: 'editor',
				sidebarContainerId: CHAT_WORKSPACE_NAVIGATION_ID, showEditorTabs: false,
				editorInput: {
					resource: URI.from({ scheme: experimentalChatGPTEditor.scheme, path: '/page' }),
					label: experimentalChatGPTEditor.title(), showBreadcrumbs: false, readOnly: true,
					capabilities: EditorInputCapabilities.CannotClose,
				},
				restoreCommand: SHOW_EXPERIMENTAL_CHATGPT, newSessionCommand: 'sessions.open.new', newDraft, focus: 'editor',
			}, undefined, source === 'restore' || source === 'startup' ? { source } : undefined);
			storage.store(CHAT_WORKSPACE_LAST_BACKEND_KEY, 'chatgpt-native', StorageScope.WORKSPACE, StorageTarget.MACHINE);
			if (source === 'startup' || source === 'restore') {
				void connect();
				return;
			}
			return connect();
		}));
		this._register(CommandsRegistry.register(newChatCommand, () => {
			chat.newChat();
			editors.focusActiveEditor();
		}));
	}
}
