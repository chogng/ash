import { ISessionGroupsService, SessionGroupsService } from '../services/sessions/browser/sessionGroupsService.js';
import { EditorInputSerializers } from '../../workbench/services/editor/common/editorInputSerializer.js';
import { Schemas } from '../../base/common/network.js';
import { ChatEditor } from '../../workbench/contrib/chat/browser/widgetHosts/editor/chatEditor.js';
import { ChatEditorInput, ChatEditorInputSerializer } from '../../workbench/contrib/chat/browser/widgetHosts/editor/chatEditorInput.js';
import { EditorPaneMatch } from '../../workbench/browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../workbench/browser/editor.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../common/agentHostSessionsProvider.js';
import { localize } from '../../nls.js';
import { Lxicon } from '../../base/common/lxicons.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import type { IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { ViewContainerLocation, type WorkbenchViewRegistry, ViewsRegistry } from '../../workbench/common/views.js';
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID } from '../../workbench/contrib/chat/common/chat.js';
import { IChatSessionNavigationService, type IChatSessionNavigationService as IChatSessionNavigationServiceContract } from '../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IViewsService } from '../../workbench/services/views/common/viewsService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { ChatViewPane } from './chatViewPane.js';
import './actions/chatActions.js';
import { registerChatSessionsActions } from '../../workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.js';
import { ChatContextKeys } from '../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { registerAction2 } from '../../platform/actions/common/actions.js';
import { ForkConversationAction } from '../../workbench/contrib/chat/browser/actions/chatForkActions.js';
import './actions/chatLayoutActions.js';
import '../contrib/sessions/browser/views/sessionsViewActions.js';

class ChatSessionNavigationService implements IChatSessionNavigationServiceContract {
	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IViewsService private readonly views: IViewsService,
	) { }

	get revision(): number { return this.sessions.navigationRevision; }

	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void; } | undefined> {
		const view = this.views.getViewWithId(CHAT_VIEW_ID);
		if (!view) return Promise.resolve(undefined);
		if (!(view instanceof ChatViewPane)) throw new Error('Chat view is unavailable for Agents Window handoff');
		return view.captureActiveDraft();
	}

	async appendToActiveDraft(text: string): Promise<void> {
		const view = await this.views.openView(CHAT_VIEW_ID);
		if (!(view instanceof ChatViewPane)) throw new Error('Chat view is unavailable for a configuration draft');
		view.appendToDraft(text);
		view.focus();
	}

	getActiveConversation(): { readonly sessionId: string; readonly threadId: string; } | undefined {
		if (this.sessions.activeUntitledSession) return undefined;
		const active = this.sessions.active;
		return active ? { sessionId: active.session.sessionId, threadId: active.threadId } : undefined;
	}

	getConversations(): readonly { readonly providerId: string; readonly sessionId: string; readonly threadId: string; readonly title: string; }[] {
		return this.sessions.sessions.filter(session => session.status === 'active').flatMap(session =>
			session.chats.filter(chat => chat.status === 'active').map(chat => ({
				providerId: LOCAL_AGENT_HOST_PROVIDER_ID,
				sessionId: session.sessionId,
				threadId: chat.threadId,
				title: `${session.title} · ${chat.title ?? 'Conversation'}`,
			})));
	}

	async openConversation(sessionId: string, threadId: string, providerId?: string): Promise<void> {
		if (providerId !== undefined && providerId !== LOCAL_AGENT_HOST_PROVIDER_ID) {
			throw new Error(localize({ bundle: 'ash.workbench', key: 'agentHosts.conversationUnavailable' }, 'This conversation belongs to another Agent host.'));
		}
		await this.sessions.openThread(sessionId, threadId);
		const active = this.getActiveConversation();
		if (active?.sessionId === sessionId && active.threadId === threadId) await this.views.focusView(CHAT_VIEW_ID);
	}
	async startVoiceConversation(): Promise<void> {
		const view = await this.views.openView(CHAT_VIEW_ID);
		if (!(view instanceof ChatViewPane)) throw new Error(localize('agentsVoice.viewUnavailable', 'Chat view is unavailable for voice'));
		await view.startVoiceConversation();
	}
}

/** Registers the Session-backed Chat view in the regular Workbench. */
export function registerChatViews(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({
		id: CHAT_VIEW_CONTAINER_ID,
		title: 'Chat',
		localizationKey: { bundle: 'ash.views', key: 'chat' },
		location: ViewContainerLocation.AuxiliaryBar,
		icon: Lxicon.chat4,
		order: 1,
		isDefault: true,
	});
	registry.registerStaticViews(CHAT_VIEW_CONTAINER_ID, [{
		id: CHAT_VIEW_ID,
		title: 'Chat',
		localizationKey: { bundle: 'ash.views', key: 'chat' },
		order: 1,
		canToggleVisibility: false,
		when: ChatContextKeys.enabled.isEqualTo(true),
		ctorDescriptor: new SyncDescriptor(ChatViewPane),
	}]);
}

registerSingleton(ISessionGroupsService, SessionGroupsService, InstantiationType.Delayed);
registerSingleton(IChatSessionNavigationService, ChatSessionNavigationService, InstantiationType.Delayed);
registerAction2(ForkConversationAction);
registerChatSessionsActions();
registerChatViews();

EditorInputSerializers.registerStatic(new ChatEditorInputSerializer());
registerEditorPane({
	id: ChatEditorInput.EditorID,
	name: localize({ bundle: 'ash.views', key: 'chat' }, 'Chat'),
	canOpen: input => input.resource.scheme === Schemas.vscodeChatEditor && input.resource.path === '/current' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(ChatEditor),
});
