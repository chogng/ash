import { Disposable, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { AshChatNavigationSource } from '../browser/ashChatNavigationSource.js';
import { ASH_CHAT_SELECTED_CONTEXT, CHAT_NAVIGATION_FOCUS_CONTEXT, CHAT_WORKSPACE_LAST_BACKEND_KEY, CHAT_WORKSPACE_NAVIGATION_ID, SHOW_ASH_CHAT_COMMAND, SHOW_CHAT_WORKSPACE_COMMAND } from '../common/constants.js';
import { ChatListCatalog, ChatWorkspaceListModel, IChatListCatalog, type ChatListSource } from '../browser/chatListModel.js';
import { SessionsView } from '../../sessions/browser/views/sessionsView.js';
import type { SessionsCatalogAccessibility } from '../../sessions/browser/views/sessionsCatalogList.js';
import { ISessionsLayoutService } from '../../../services/layout/common/sessionsLayoutService.js';
import '../browser/chat.contribution.js';

export function registerChatWorkspace(webChat: {
	readonly catalog: SyncDescriptor<ChatListSource>;
	readonly accessibility: Omit<SessionsCatalogAccessibility, 'focusContext'>;
	readonly openCommand: string;
}): void {
	registerSingleton(IChatListCatalog, new SyncDescriptor(ChatListCatalog, [[
		webChat.catalog,
		new SyncDescriptor(AshChatNavigationSource),
	]], true));

	registerChatWorkspaceNavigation(webChat.accessibility);

	registerWorkbenchContribution(ChatWorkspaceContribution.ID, WorkbenchPhase.BlockRestore,
		accessor => accessor.get(IInstantiationService).createInstance(ChatWorkspaceContribution, webChat.openCommand));
}

export function registerChatWorkspaceNavigation(accessibility: Omit<SessionsCatalogAccessibility, 'focusContext'>): IDisposable {
	const registrations = new DisposableStore();
	const title = 'Chat';
	const localizationKey = { bundle: 'ash', key: 'sessions.activity.chat' };
	registrations.add(SessionsViewRegistry.registerViewContainer({
		id: CHAT_WORKSPACE_NAVIGATION_ID, title, localizationKey, location: ViewContainerLocation.Sidebar, isDefault: true, order: 2,
	}));
	registrations.add(SessionsViewRegistry.registerViews(CHAT_WORKSPACE_NAVIGATION_ID, [{
		id: CHAT_WORKSPACE_NAVIGATION_ID + '.view',
		title, localizationKey, canToggleVisibility: false,
		ctorDescriptor: new SyncDescriptor(SessionsView, [{
			input: new SyncDescriptor(ChatWorkspaceListModel),
			accessibility: { ...accessibility, focusContext: CHAT_NAVIGATION_FOCUS_CONTEXT },
		}]),
	}]));
	return registrations;
}

export class ChatWorkspaceContribution extends Disposable {
	static readonly ID = 'sessions.chatWorkspace';

	constructor(
		openWebChatCommand: string,
		@ISessionsLayoutService layout: ISessionsLayoutService,
		@IStorageService storage: IStorageService,
	) {
		super();
		this._register(CommandsRegistry.register(SHOW_ASH_CHAT_COMMAND, async (_accessor, source) => {
			await layout.openEntry({
				id: 'ashChat', workspaceMode: 'chat', activityContext: ASH_CHAT_SELECTED_CONTEXT,
				content: 'conversation', conversationKind: 'code', sidebarContainerId: CHAT_WORKSPACE_NAVIGATION_ID,
				splash: 'chat',
				restoreCommand: SHOW_ASH_CHAT_COMMAND, newSessionCommand: 'sessions.open.new', newDraft: 'conversation', focus: 'conversation',
			}, undefined, source === 'restore' ? { source } : undefined);
			storage.store(CHAT_WORKSPACE_LAST_BACKEND_KEY, 'ash', StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}));
		this._register(CommandsRegistry.register(SHOW_CHAT_WORKSPACE_COMMAND, accessor => {
			const command = storage.get(CHAT_WORKSPACE_LAST_BACKEND_KEY, StorageScope.WORKSPACE) === 'ash' ? SHOW_ASH_CHAT_COMMAND : openWebChatCommand;
			return accessor.get(ICommandService).executeCommand(command);
		}));
	}
}
