import { Disposable } from '../../../../base/common/lifecycle.js';
import { derived } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { ASH_CHAT_SELECTED_CONTEXT, SHOW_ASH_CHAT_COMMAND, SHOW_CHAT_WORKSPACE_COMMAND } from '../../chat/common/constants.js';
import type { ReplyChatEditorOptions } from '../../chat/browser/replyChatEditor.js';
import { ChatGPTWidgetModel } from './chatGPTWidgetModel.js';
import { IChatGPTService, chatGPTNavigationContainerId } from './chatGPTService.js';
import { ISessionsSearchService } from '../../search/browser/searchService.js';
import type { SearchResult } from '../../search/browser/searchModel.js';

export const chatGPTScrollOptimization = 'sessions.chatgpt.optimizeScrolling';

export const chatGPTReplyEditor = {
	id: 'sessions.editor.chatgpt',
	scheme: 'ash-chatgpt',
	name: 'ChatGPT',
	rootClass: 'ash-chatgpt-widget',
	title: () => localize('sessions.chatgpt.title', 'ChatGPT'),
	inputLabel: () => localize('sessions.chatgpt.prompt', 'Ask ChatGPT'),
	model: new SyncDescriptor(ChatGPTWidgetModel),
	accessibility: {
		focusContext: 'chatGPTFocused',
		verbositySetting: AccessibilityVerbositySettingId.ChatGPT,
		hint: () => localize('sessions.chatgpt.navigationHint', 'Press Alt+F1 for ChatGPT accessibility help.'),
	},
	scrollOptimizationSetting: chatGPTScrollOptimization,
	alternateModel: {
		source: 'chatgpt',
		label: () => localize('sessions.newChatModel.useAsh', 'New Ash Chat with Model…'),
	},
} satisfies ReplyChatEditorOptions;
const chatBackendKey = 'sessions.chat.lastBackend';
const newAshChatCommand = 'sessions.chat.newAsh';

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
		const showChat = async (source?: unknown) => {
			chat.initialize();
			await layout.openEntry({
				id: 'chatgpt', activityContext: 'sessions.activity.chatgptSelected', content: 'editor',
				sidebarContainerId: chatGPTNavigationContainerId, showEditorTabs: false,
				useConversationBackground: true,
				editorInput: {
					resource: URI.from({ scheme: chatGPTReplyEditor.scheme, path: '/page' }), label: chatGPTReplyEditor.title(),
					showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
				},
				restoreCommand: 'sessions.show.chatgpt', newSessionCommand: 'sessions.chatgpt.newChat', focus: 'editor',
			}, undefined, source === 'restore' ? { source } : undefined);
			storage.store(chatBackendKey, 'chatgpt', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		};
		const showAsh = async (source?: unknown) => {
			await layout.openEntry({
				id: 'ashChat', workspaceMode: 'chat', activityContext: ASH_CHAT_SELECTED_CONTEXT,
				content: 'conversation', conversationKind: 'code', sidebarContainerId: chatGPTNavigationContainerId,
				restoreCommand: SHOW_ASH_CHAT_COMMAND, newSessionCommand: newAshChatCommand, focus: 'conversation',
			}, undefined, source === 'restore' ? { source } : undefined);
			storage.store(chatBackendKey, 'ash', StorageScope.WORKSPACE, StorageTarget.MACHINE);
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
		this._register(CommandsRegistry.register('sessions.show.chatgpt', (_accessor, source) => showChat(source)));
		this._register(CommandsRegistry.register(SHOW_ASH_CHAT_COMMAND, (_accessor, source) => showAsh(source)));
		this._register(CommandsRegistry.register(SHOW_CHAT_WORKSPACE_COMMAND, () => storage.get(chatBackendKey, StorageScope.WORKSPACE) === 'ash' ? showAsh() : showChat()));
		this._register(CommandsRegistry.register(newAshChatCommand, accessor => {
			accessor.get(ISessionsService).openNewSession(undefined, { providerId: LOCAL_AGENT_HOST_PROVIDER_ID });
			accessor.get(ILayoutService).focus();
		}));
		this._register(CommandsRegistry.register('sessions.open.new', async (_accessor, source) => {
			if (source !== 'restore') { chat.newChat(); }
			await showChat(source);
		}));
		// Saved window entries and existing keybindings from the experiment retain the same chat owner.
		this._register(CommandsRegistry.register('sessions.chatgptNative.newChat', newChat));
		for (const command of ['sessions.show.chatgptNative', 'sessions.open.chatgptNative']) {
			this._register(CommandsRegistry.register(command, (_accessor, source) => showChat(source)));
		}
	}
}
