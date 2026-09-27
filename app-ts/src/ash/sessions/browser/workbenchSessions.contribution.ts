import { onUnexpectedError } from '../../base/common/errors.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { IRendererHostService, type IRendererHost } from '../../platform/renderer/common/rendererHost.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { IChatSessionNavigationService, type IChatSessionNavigationService as IChatSessionNavigationServiceContract } from '../../workbench/services/chat/common/chatSessionNavigationService.js';
import { AppServerSessionsProvider } from '../contrib/providers/appServer/browser/appServerSessionsProvider.js';
import { SessionsManagementService } from '../services/sessions/browser/sessionsManagementService.js';
import { ISessionsManagementService } from '../services/sessions/common/sessionsManagement.js';

class WorkbenchSessionsManagementService extends SessionsManagementService {
	constructor(@IRendererHostService api: IRendererHost) {
		super(new AppServerSessionsProvider({ session: api.session, model: api.model, turn: api.turn, events: api.events }));
	}
}

class ChatSessionNavigationService implements IChatSessionNavigationServiceContract {
	constructor(@ISessionsManagementService private readonly sessions: ISessionsManagementService) {}

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

class WorkbenchSessionsStartupContribution extends Disposable {
	constructor(@ISessionsManagementService sessions: ISessionsManagementService) {
		super();
		void sessions.initialize().catch(onUnexpectedError);
	}
}

registerSingleton(ISessionsManagementService, WorkbenchSessionsManagementService, InstantiationType.Delayed);
registerSingleton(IChatSessionNavigationService, ChatSessionNavigationService, InstantiationType.Delayed);
registerWorkbenchContribution('sessions.contrib.workbenchStartup', WorkbenchPhase.BlockRestore,
	accessor => accessor.get(IInstantiationService).createInstance(WorkbenchSessionsStartupContribution));
