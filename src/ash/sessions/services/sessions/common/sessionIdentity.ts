import type { ISession, AgentTreeNode, ThreadOrigin } from './session.js';

const prefix = 'ash-session:';

/** Window identities isolate identical backend identifiers without changing protocol identities. */
export function sessionIdentity(providerId: string, backendSessionId: string, defaultProviderId: string): string {
	return providerId === defaultProviderId
		? backendSessionId
		: `${prefix}${encodeURIComponent(providerId)}/${encodeURIComponent(backendSessionId)}`;
}

export function parseSessionIdentity(
	sessionId: string,
	defaultProviderId: string,
): { readonly providerId: string; readonly backendSessionId: string } {
	if (!sessionId.startsWith(prefix)) return { providerId: defaultProviderId, backendSessionId: sessionId };
	const separator = sessionId.indexOf('/', prefix.length);
	if (separator < 0) throw new Error('Invalid qualified Session identity');
	const providerId = decodeURIComponent(sessionId.slice(prefix.length, separator));
	const backendSessionId = decodeURIComponent(sessionId.slice(separator + 1));
	if (
		!providerId ||
		!backendSessionId ||
		sessionIdentity(providerId, backendSessionId, defaultProviderId) !== sessionId
	)
		throw new Error('Invalid qualified Session identity');
	return { providerId, backendSessionId };
}

export function threadIdentity(providerId: string, threadId: string, defaultProviderId: string): string {
	return sessionIdentity(providerId, threadId, defaultProviderId);
}

function mapOrigin(origin: ThreadOrigin, map: (value: string) => string): ThreadOrigin {
	return origin.type === 'root' ? origin : { ...origin, parentThreadId: map(origin.parentThreadId) };
}

function mapSessionThreads(session: ISession, map: (value: string) => string): Pick<ISession, 'chats' | 'agentTree'> {
	const tree = (node: AgentTreeNode): AgentTreeNode => ({
		...node,
		threadId: map(node.threadId),
		origin: mapOrigin(node.origin, map),
		children: node.children.map(tree),
	});
	return {
		chats: session.chats.map(chat => ({
			...chat,
			threadId: map(chat.threadId),
			origin: mapOrigin(chat.origin, map),
		})),
		agentTree: session.agentTree?.map(tree),
	};
}

export function projectSession(
	session: ISession,
	providerId: string,
	providerLabel: string,
	defaultProviderId: string,
): ISession {
	// Existing ambient records retain object identity and persisted raw IDs.
	if (providerId === defaultProviderId) return session;
	return {
		...session,
		...mapSessionThreads(session, value => threadIdentity(providerId, value, defaultProviderId)),
		sessionId: sessionIdentity(providerId, session.sessionId, defaultProviderId),
		providerId,
		providerLabel,
		backendSessionId: session.sessionId,
	};
}

export function backendSession(session: ISession, defaultProviderId: string): ISession {
	return session.backendSessionId === undefined
		? session
		: {
				...session,
				...mapSessionThreads(session, value => parseSessionIdentity(value, defaultProviderId).backendSessionId),
				sessionId: session.backendSessionId,
			};
}

/** Opaque link authority; only the Sessions owner decodes its provider namespace. */
export function sessionProviderAuthority(providerId: string, defaultProviderId: string): string {
	return providerId === defaultProviderId ? 'local' : `sessions+${encodeURIComponent(providerId)}`;
}

export function parseSessionProviderAuthority(authority: string, defaultProviderId: string): string {
	if (authority === 'local') return defaultProviderId;
	if (!authority.startsWith('sessions+')) throw new Error('Unknown Session host authority');
	const providerId = decodeURIComponent(authority.slice('sessions+'.length));
	if (!providerId || sessionProviderAuthority(providerId, defaultProviderId) !== authority)
		throw new Error('Invalid Session host authority');
	return providerId;
}

export function mapAgentSession(
	value: import('../../../../platform/agentHost/common/agent.js').AgentSession,
	identity: (value: string) => string,
): import('../../../../platform/agentHost/common/agent.js').AgentSession {
	return {
		...value,
		sessionId: identity(value.sessionId),
		threads: value.threads.map(thread => ({
			...thread,
			threadId: identity(thread.threadId),
			parentThreadId: thread.parentThreadId && identity(thread.parentThreadId),
			forkedFromId: thread.forkedFromId && identity(thread.forkedFromId),
		})),
	};
}

export function mapAgentExecutionNode(
	value: import('../../../../platform/agentHost/common/agent.js').AgentExecutionNode,
	identity: (value: string) => string,
): import('../../../../platform/agentHost/common/agent.js').AgentExecutionNode {
	return {
		...value,
		threadId: identity(value.threadId),
		parentThreadId: value.parentThreadId && identity(value.parentThreadId),
		forkedFromId: value.forkedFromId && identity(value.forkedFromId),
		goal: value.goal && { ...value.goal, threadId: identity(value.goal.threadId) },
		children: value.children?.map(node => mapAgentExecutionNode(node, identity)),
	};
}

export function mapAgentThreadRead<T extends import('../../../../platform/agentHost/common/agent.js').ThreadRead>(
	value: T,
	identity: (value: string) => string,
): T {
	const pair = <P extends { readonly sessionId: string; readonly threadId: string }>(record: P): P => ({
		...record,
		sessionId: identity(record.sessionId),
		threadId: identity(record.threadId),
	});
	const origin =
		value.thread.origin.type === 'root'
			? value.thread.origin
			: value.thread.origin.type === 'replacement'
				? { ...value.thread.origin, sourceThreadId: identity(value.thread.origin.sourceThreadId) }
				: { ...value.thread.origin, parentThreadId: identity(value.thread.origin.parentThreadId) };
	return {
		...value,
		thread: {
			...pair(value.thread),
			origin,
			goal: value.thread.goal && { ...value.thread.goal, threadId: identity(value.thread.goal.threadId) },
		},
		transcript: pair(value.transcript),
	};
}
