import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ChatGPTNewDraftContext } from '../../../common/contextkeys.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { CHAT_WORKSPACE_LAST_BACKEND_KEY, CHAT_WORKSPACE_NAVIGATION_ID } from '../../chat/common/constants.js';
import type { ReplyChatEditorOptions } from '../../chat/browser/replyChatEditor.js';
import { ChatGPTWidgetModel } from './chatGPTWidgetModel.js';
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

export class ChatGPTWebContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'sessions.chatgpt.web';
	constructor(
		@ISessionsLayoutService layout: ISessionsLayoutService,
		@IChatGPTService chat: IChatGPTService,
		@ISessionsSearchService search: ISessionsSearchService,
		@IEditorService editors: IEditorService,
		@IStorageService storage: IStorageService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		const newDraft = ChatGPTNewDraftContext.bindTo(contextKeys);
		this._register(autorun(reader => {
			const state = chat.state.read(reader);
			newDraft.set(isChatGPTNewDraft(state));
		}));
		this._register(toDisposable(() => newDraft.reset()));
		const showChat = async (source?: unknown) => {
			chat.initialize();
			await layout.openEntry({
				id: 'chatgpt', activityContext: chatGPTSelectedContext, content: 'editor',
				sidebarContainerId: CHAT_WORKSPACE_NAVIGATION_ID, showEditorTabs: false,
				editorInput: {
					resource: URI.from({ scheme: chatGPTReplyEditor.scheme, path: '/page' }), label: chatGPTReplyEditor.title(),
					showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
				},
				restoreCommand: SHOW_CHATGPT_COMMAND, newSessionCommand: 'sessions.chatgpt.newChat', focus: 'editor',
			}, undefined, source === 'restore' ? { source } : undefined);
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
