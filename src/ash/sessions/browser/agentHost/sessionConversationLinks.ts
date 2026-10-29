import { canceled } from '../../../base/common/errors.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import type { OpenSessionLink } from '../../../platform/agentHost/common/openSessionLink.js';
import { ISessionProviderScopeService } from './sessionProviderScopeService.js';
import { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { sessionIdentity, sessionProviderAuthority, parseSessionProviderAuthority } from '../../services/sessions/common/sessionIdentity.js';

/** Backend coordinates stay short and host-owned; window identities never enter copied links. */
export class SessionConversationLinks {
	constructor(
		private readonly defaultProviderId: string,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
		@ISessionsService private readonly sessions: ISessionsService,
	) {}
	async prepare(sessionId: string, threadId: string): Promise<OpenSessionLink> {
		const scope = this.scopes.getScope(sessionId);
		scope.assertCurrent();
		const backendSessionId = scope.backendIdentity(sessionId);
		const backendThreadId = scope.backendIdentity(threadId);
		const appServer = scope.services.host.appServer;
		const generation = appServer.connectionGeneration;
		let retired = false;
		const listener = appServer.onConnectionState(state => {
			if (state !== 'ready') retired = true;
		});
		using listenerLifetime = toDisposable(() => listener.dispose());
		const result = await scope.services.chat.readThread(backendSessionId, backendThreadId);
		const state = await appServer.getConnectionState();
		scope.assertCurrent();
		if (retired || appServer.connectionGeneration !== generation || state !== 'ready') throw canceled();
		if (result.thread.sessionId !== backendSessionId || result.thread.threadId !== backendThreadId)
			throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
		return {
			connectionAuthority: sessionProviderAuthority(scope.providerId, this.defaultProviderId),
			sessionId: backendSessionId,
			threadId: backendThreadId,
		};
	}
	async open(address: OpenSessionLink): Promise<void> {
		const providerId = parseSessionProviderAuthority(address.connectionAuthority, this.defaultProviderId);
		const sessionId = sessionIdentity(providerId, address.sessionId, this.defaultProviderId);
		const threadId = sessionIdentity(providerId, address.threadId, this.defaultProviderId);
		const revision = this.sessions.navigationRevision;
		await this.prepare(sessionId, threadId);
		if (revision !== this.sessions.navigationRevision) throw canceled();
		await this.sessions.openThread(sessionId, threadId);
	}
}
