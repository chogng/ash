import { Disposable } from '../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../platform/commands/common/commands.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { SessionsViewRegistry } from '../common/views.js';
import { AshChatNavigationSource } from '../contrib/chat/browser/ashChatNavigationSource.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_WORKSPACE_LAST_BACKEND_KEY, CHAT_WORKSPACE_NAVIGATION_ID, SHOW_ASH_CHAT_COMMAND, SHOW_CHAT_WORKSPACE_COMMAND } from '../contrib/chat/common/constants.js';
import { ChatGPTNavigationSource } from '../contrib/chatgptweb/browser/chatGPTNavigationView.js';
import { chatGPTReplyEditor } from '../contrib/chatgptweb/browser/chatGPTWeb.js';
import { ChatNavigationViewPaneContainer } from '../contrib/sessions/browser/views/chatNavigationView.js';
import { ISessionsLayoutService } from '../services/layout/common/sessionsLayoutService.js';
import '../contrib/chat/browser/chat.contribution.js';
import '../contrib/chatgptweb/browser/chatGPTWeb.contribution.js';
import './actions/newChatModelAction.js';

SessionsViewRegistry.registerViewContainer({
	id: CHAT_WORKSPACE_NAVIGATION_ID,
	ctorDescriptor: new SyncDescriptor(ChatNavigationViewPaneContainer, [[
		new SyncDescriptor(ChatGPTNavigationSource),
		new SyncDescriptor(AshChatNavigationSource),
	], chatGPTReplyEditor.accessibility]),
	mergeViewWithContainerWhenSingleView: false, title: 'Chat', localizationKey: { bundle: 'ash', key: 'sessions.activity.chat' }, location: ViewContainerLocation.Sidebar, isDefault: true, order: 2,
});

export class ChatWorkspaceContribution extends Disposable {
	static readonly ID = 'sessions.chatWorkspace';

	constructor(
		@ISessionsLayoutService layout: ISessionsLayoutService,
		@IStorageService storage: IStorageService,
	) {
		super();
		this._register(CommandsRegistry.register(SHOW_ASH_CHAT_COMMAND, async (_accessor, source) => {
			await layout.openEntry({
				id: 'ashChat', workspaceMode: 'chat', activityContext: ASH_CHAT_SELECTED_CONTEXT,
				content: 'conversation', conversationKind: 'code', sidebarContainerId: CHAT_WORKSPACE_NAVIGATION_ID,
				restoreCommand: SHOW_ASH_CHAT_COMMAND, newSessionCommand: 'sessions.open.new', focus: 'conversation',
			}, undefined, source === 'restore' ? { source } : undefined);
			storage.store(CHAT_WORKSPACE_LAST_BACKEND_KEY, 'ash', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}));
		this._register(CommandsRegistry.register(SHOW_CHAT_WORKSPACE_COMMAND, accessor => {
			const command = storage.get(CHAT_WORKSPACE_LAST_BACKEND_KEY, StorageScope.WORKSPACE) === 'ash' ? SHOW_ASH_CHAT_COMMAND : 'sessions.show.chatgpt';
			return accessor.get(ICommandService).executeCommand(command);
		}));
	}
}

registerWorkbenchContribution(ChatWorkspaceContribution.ID, WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(ChatWorkspaceContribution));
