import { canceled, isCancellationError } from '../../../base/common/errors.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import type { IChatSessionConnection, IPreparedChatConversation } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import type { OpenSessionLink } from '../../../platform/agentHost/common/openSessionLink.js';
import { ISessionProviderScopeService } from './sessionProviderScopeService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { sessionIdentity, sessionProviderAuthority, parseSessionProviderAuthority } from '../../services/sessions/common/sessionIdentity.js';

/** Backend coordinates stay short and host-owned; window identities never enter copied links. */
export class SessionConversationLinks {
	constructor(
		private readonly defaultProviderId: string,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
	) { }
	captureConnection(sessionId: string): IChatSessionConnection {
		const scope = this.scopes.getScope(sessionId);
		scope.assertCurrent();
		const appServer = scope.services.host.appServer;
		const generation = appServer.connectionGeneration;
		let retired = false;
		const listener = appServer.onConnectionState(() => { retired = true; });
		const assertCurrent = (): void => {
			scope.assertCurrent();
			if (retired || generation !== appServer.connectionGeneration) throw canceled();
		};
		return Object.assign(toDisposable(() => { retired = true; listener.dispose(); }), {
			generation,
			assertCurrent: async () => {
				assertCurrent();
				const state = await appServer.getConnectionState();
				assertCurrent();
				if (state !== 'ready') throw canceled();
			},
		});
	}
	async prepare(sessionId: string, threadId: string): Promise<OpenSessionLink> {
		return (await this.prepareConversation(sessionId, threadId)).link;
	}
	async prepareConversation(sessionId: string, threadId: string): Promise<IPreparedChatConversation> {
		const scope = this.scopes.getScope(sessionId);
		scope.assertCurrent();
		const backendSessionId = scope.backendIdentity(sessionId);
		const backendThreadId = scope.backendIdentity(threadId);
		using connection = this.captureConnection(sessionId);
		const result = await scope.services.chat.readThread(backendSessionId, backendThreadId);
		await connection.assertCurrent();
		if (result.thread.sessionId !== backendSessionId || result.thread.threadId !== backendThreadId) throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
		return {
			link: { connectionAuthority: sessionProviderAuthority(scope.providerId, this.defaultProviderId), sessionId: backendSessionId, threadId: backendThreadId },
			directory: result.directory,
		};
	}
	async open(
		address: OpenSessionLink,
		navigation: Pick<ISessionsService, 'navigationRevision' | 'openThread'>,
		options?: {
			readonly connectMissingHost?: (providerId: string, assertCurrent: () => void) => Promise<boolean>;
			readonly sideBySide?: boolean;
		},
	): Promise<{ readonly sessionId: string; readonly threadId: string; }> {
		const providerId = parseSessionProviderAuthority(address.connectionAuthority, this.defaultProviderId);
		const revision = navigation.navigationRevision;
		const assertCurrent = (): void => {
			if (revision !== navigation.navigationRevision) throw canceled();
		};
		try {
			this.scopes.getProviderScope(providerId);
		} catch (error) {
			if (!isCancellationError(error)) throw error;
			if (!await options?.connectMissingHost?.(providerId, assertCurrent)) {
				throw new Error(localize('chat.sessionLink.connection', 'The connection for this conversation link is unavailable.'));
			}
			assertCurrent();
			this.scopes.getProviderScope(providerId);
		}
		const sessionId = sessionIdentity(providerId, address.sessionId, this.defaultProviderId);
		const threadId = sessionIdentity(providerId, address.threadId, this.defaultProviderId);
		await this.prepare(sessionId, threadId);
		assertCurrent();
		await navigation.openThread(sessionId, threadId, options?.sideBySide ? { sideBySide: true } : undefined);
		return { sessionId, threadId };
	}
}
