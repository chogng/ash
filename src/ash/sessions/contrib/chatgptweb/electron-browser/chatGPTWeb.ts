import { Disposable } from '../../../../base/common/lifecycle.js';
import { derived, type IObservable } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
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
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { CHAT_WORKSPACE_LAST_BACKEND_KEY, CHAT_WORKSPACE_NAVIGATION_ID } from '../../chat/common/constants.js';
import type { ChatDraftModelSource } from '../../chat/browser/ashChatWidgetModel.js';
import type { IReplyChatEditorModel, ReplyChatEditorOptions } from '../../chat/browser/replyChatEditor.js';
import { chatGPTModelEntries, ChatGPTWidgetModel } from './chatGPTWidgetModel.js';
import { ChatGPTProjectFolderPicker } from './chatGPTProjectFolderPicker.js';
import { IChatGPTService, isChatGPTNewDraft } from '../browser/chatGPTService.js';
import { ISessionsSearchService } from '../../search/browser/searchService.js';
import type { SearchResult } from '../../search/browser/searchModel.js';

export const chatGPTScrollOptimization = 'sessions.chatgpt.optimizeScrolling';
export const SHOW_CHATGPT_COMMAND = 'sessions.show.chatgpt';

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
			if (capture && !destination.draft && !destination.attachments.length && !destination.draftTarget) {
				this.chat.setDraft(capture.draft.text);
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
		@ISessionsLayoutService layout: ISessionsLayoutService,
		@IChatGPTService chat: IChatGPTService,
		@ISessionsSearchService search: ISessionsSearchService,
		@IEditorService editors: IEditorService,
		@IStorageService storage: IStorageService,
	) {
		super();
		const newDraft = chat.state.map(isChatGPTNewDraft);
		const showChat = async (source?: unknown) => {
			chat.initialize();
			await layout.openEntry({
				id: 'chatgpt', activityContext: chatGPTSelectedContext, content: 'editor', splash: 'chat',
				sidebarContainerId: CHAT_WORKSPACE_NAVIGATION_ID, showEditorTabs: false,
				editorInput: {
					resource: URI.from({ scheme: chatGPTReplyEditor.scheme, path: '/page' }), label: chatGPTReplyEditor.title(),
					showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
				},
				restoreCommand: SHOW_CHATGPT_COMMAND, newSessionCommand: 'sessions.chatgpt.newChat', newDraft, focus: 'editor',
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
		this._register(CommandsRegistry.register(SHOW_CHATGPT_COMMAND, (_accessor, source) => showChat(source)));
		this._register(CommandsRegistry.register('sessions.open.new', async (_accessor, source) => {
			if (source !== 'restore') { chat.newChat(source === 'startup' ? { clearDraft: true } : undefined); }
			await showChat(source);
		}));
		// Saved window entries and existing keybindings from the experiment retain the same chat owner.
		this._register(CommandsRegistry.register('sessions.chatgptNative.newChat', newChat));
		for (const command of ['sessions.show.chatgptNative', 'sessions.open.chatgptNative']) {
			this._register(CommandsRegistry.register(command, (_accessor, source) => showChat(source)));
		}
	}
}
