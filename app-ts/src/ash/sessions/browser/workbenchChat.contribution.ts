import { Lxicon } from '../../base/common/lxicons.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import type { IOpenAgentsWindowOptions } from '../../platform/native/common/nativeHost.js';
import { ViewContainerLocation, type WorkbenchViewRegistry, ViewsRegistry } from '../../workbench/common/views.js';
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID } from '../../workbench/contrib/chat/common/chat.js';
import { IChatSessionNavigationService, type IChatSessionNavigationService as IChatSessionNavigationServiceContract } from '../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IViewsService } from '../../workbench/services/views/browser/viewsService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';
import { ChatViewPane } from './chatViewPane.js';
import './actions/chatActions.js';
import './actions/chatLayoutActions.js';

class ChatSessionNavigationService implements IChatSessionNavigationServiceContract {
	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IViewsService private readonly views: IViewsService,
	) {}

	captureActiveDraft(): Promise<{ readonly draft: NonNullable<IOpenAgentsWindowOptions['draft']>; clear(): void } | undefined> {
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

	getActiveConversation(): { readonly sessionId: string; readonly threadId: string } | undefined {
		if (this.sessions.activeUntitledSession) return undefined;
		const active = this.sessions.active;
		return active ? { sessionId: active.session.sessionId, threadId: active.threadId } : undefined;
	}

	getConversations(): readonly { readonly sessionId: string; readonly threadId: string; readonly title: string }[] {
		return this.sessions.sessions.filter(session => session.status === 'active').flatMap(session =>
			session.chats.filter(chat => chat.status === 'active').map(chat => ({
				sessionId: session.sessionId,
				threadId: chat.threadId,
				title: `${session.title} · ${chat.title ?? 'Conversation'}`,
			})));
	}

	openConversation(sessionId: string, threadId: string): Promise<void> {
		return this.sessions.openThread(sessionId, threadId);
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
		ctorDescriptor: new SyncDescriptor(ChatViewPane),
	}]);
}

registerSingleton(IChatSessionNavigationService, ChatSessionNavigationService, InstantiationType.Delayed);
registerChatViews();
