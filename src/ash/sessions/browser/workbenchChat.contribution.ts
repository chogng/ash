import { ISessionsListModelService, SessionsListModelService } from '../services/sessions/browser/sessionsListModelService.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { SavedSSHConversationHost } from './agentHost/savedSSHConversationHost.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import type { OpenSessionLink } from '../../platform/agentHost/common/openSessionLink.js';
import { SessionConversationLinks } from './agentHost/sessionConversationLinks.js';
import { parseSessionIdentity, sessionIdentity } from '../services/sessions/common/sessionIdentity.js';
import { IAgentSessionActionsService } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { SessionActionsService } from './sessionActionsService.js';
import { ChatViewPane } from '../../workbench/contrib/chat/browser/widgetHosts/viewPane/chatViewPane.js';
import { ISessionGroupsService, SessionGroupsService } from '../services/sessions/browser/sessionGroupsService.js';
import { EditorInputSerializers } from '../../workbench/services/editor/common/editorInputSerializer.js';
import { ChatEditor } from '../../workbench/contrib/chat/browser/widgetHosts/editor/chatEditor.js';
import { ChatEditorInput, ChatEditorInputSerializer } from '../../workbench/contrib/chat/browser/widgetHosts/editor/chatEditorInput.js';
import { EditorPaneMatch } from '../../workbench/browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../workbench/browser/editor.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID, SSH_AGENT_HOST_PROVIDER_PREFIX } from '../common/agentHostSessionsProvider.js';
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
import { SessionChatViewPane } from './chatViewPane.js';
import { IAgentSessionsService } from '../../workbench/contrib/chat/browser/agentSessions/agentSessionsService.js';
import { ChatHistoryModel } from './chatHistoryModel.js';
import { registerChatSessionsActions } from '../../workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.js';
import { ChatContextKeys } from '../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { registerAction2 } from '../../platform/actions/common/actions.js';
import { ForkConversationAction } from '../../workbench/contrib/chat/browser/actions/chatForkActions.js';
import '../contrib/sessions/browser/sessionsActions.js';
import '../contrib/sessions/browser/views/sessionsViewActions.js';
import { IChatService, type ChatAgent } from '../../workbench/services/chat/common/chatService.js';
import type { ToolResultPresentation } from '../../platform/agentHost/common/agent.js';

class ChatSessionNavigationService extends Disposable implements IChatSessionNavigationServiceContract {
	private readonly links: SessionConversationLinks;
	private readonly linkLifetime = new AbortController();

	constructor(
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IViewsService private readonly views: IViewsService,
		@IChatService private readonly chat: IChatService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this._register(toDisposable(() => this.linkLifetime.abort()));
		this.links = instantiation.createInstance(SessionConversationLinks, LOCAL_AGENT_HOST_PROVIDER_ID);
	}

	captureConnection(sessionId: string) { return this.links.captureConnection(sessionId); }

	prepareConversationLink(sessionId: string, threadId: string): Promise<OpenSessionLink> {
		return this.links.prepare(sessionId, threadId);
	}

	async openConversationLink(address: OpenSessionLink): Promise<void> {
		const { sessionId, threadId } = await this.links.open(address, this.sessions, {
			connectMissingHost: async (providerId, assertCurrent) => {
				if (!providerId.startsWith(SSH_AGENT_HOST_PROVIDER_PREFIX)) return false;
				return this.instantiation.createInstance(SavedSSHConversationHost).connect(providerId, assertCurrent, this.linkLifetime.signal);
			},
		});
		await this.focusConversation(sessionId, threadId);
	}

	async openToolResult(sourceSessionId: string, target: ToolResultPresentation, signal: AbortSignal): Promise<void> {
		if (signal.aborted || target.type !== 'sessionTarget' || !this.sessions.sessions.some(session => session.sessionId === sourceSessionId)) {
			throw new Error(localize('chat.tool.resultUnavailable', 'This result is unavailable on its originating host.'));
		}
		const revision = this.revision;
		const { providerId } = parseSessionIdentity(sourceSessionId, LOCAL_AGENT_HOST_PROVIDER_ID);
		const sessionId = sessionIdentity(providerId, target.sessionId, LOCAL_AGENT_HOST_PROVIDER_ID);
		const threadId = sessionIdentity(providerId, target.threadId, LOCAL_AGENT_HOST_PROVIDER_ID);
		await this.chat.readThread(sessionId, threadId);
		if (signal.aborted || revision !== this.revision) return;
		await this.openConversation(sessionId, threadId);
	}

	async createNewConversation(options?: { readonly focus?: boolean; readonly providerId?: string; readonly agent?: ChatAgent; }): Promise<boolean> {
		if (options?.providerId !== undefined && options.providerId !== LOCAL_AGENT_HOST_PROVIDER_ID) throw new Error(localize({ bundle: 'ash.workbench', key: 'agentHosts.conversationUnavailable' }, 'This conversation belongs to another Agent host.'));
		const draft = this.sessions.createUntitledSession();
		if (options?.agent) this.sessions.setUntitledSessionAgent(draft.untitledSessionId, options.agent);
		return options?.focus ? this.views.focusView(CHAT_VIEW_ID) : true;
	}

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

	getConversations(): readonly { readonly providerId: string; readonly providerLabel?: string; readonly sessionId: string; readonly threadId: string; readonly title: string; }[] {
		return this.sessions.sessions.filter(session => session.status === 'active').flatMap(session =>
			session.chats.filter(chat => chat.status === 'active').map(chat => ({
				providerId: session.providerId ?? LOCAL_AGENT_HOST_PROVIDER_ID,
				providerLabel: session.providerLabel,
				sessionId: session.sessionId,
				threadId: chat.threadId,
				title: `${session.title} · ${chat.title ?? 'Conversation'}`,
			})));
	}

	async openConversation(sessionId: string, threadId: string, providerId?: string): Promise<void> {
		if (providerId !== undefined && providerId !== parseSessionIdentity(sessionId, LOCAL_AGENT_HOST_PROVIDER_ID).providerId) {
			throw new Error(localize({ bundle: 'ash.workbench', key: 'agentHosts.conversationUnavailable' }, 'This conversation belongs to another Agent host.'));
		}
		await this.sessions.openThread(sessionId, threadId);
		await this.focusConversation(sessionId, threadId);
	}

	private async focusConversation(sessionId: string, threadId: string): Promise<void> {
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
		icon: Lxicon.chat,
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
		ctorDescriptor: new SyncDescriptor(SessionChatViewPane),
	}]);
}

registerSingleton(ISessionGroupsService, SessionGroupsService, InstantiationType.Delayed);
registerSingleton(IChatSessionNavigationService, ChatSessionNavigationService, InstantiationType.Delayed);
registerSingleton(ISessionsListModelService, SessionsListModelService, InstantiationType.Delayed);
registerSingleton(IAgentSessionsService, ChatHistoryModel, InstantiationType.Delayed);
registerAction2(ForkConversationAction);
registerChatSessionsActions();
registerChatViews();

EditorInputSerializers.registerStatic(new ChatEditorInputSerializer());
registerEditorPane({
	id: ChatEditorInput.EditorID,
	name: localize({ bundle: 'ash.views', key: 'chat' }, 'Chat'),
	canOpen: input => input instanceof ChatEditorInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(ChatEditor),
});

registerSingleton(IAgentSessionActionsService, SessionActionsService, InstantiationType.Delayed);
