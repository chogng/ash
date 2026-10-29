import type { IAgentSessionService } from '../../../platform/agentHost/common/agentService.js';
import type { SessionResult } from '../../../platform/agentHost/common/agent.js';
import { ISessionProviderScopeService, type ISessionProviderScope } from './sessionProviderScopeService.js';
import {
	mapAgentSession,
	mapAgentExecutionNode,
	mapAgentThreadRead,
} from '../../services/sessions/common/sessionIdentity.js';

/** Shared session commands borrow the same raw backend ports as the owning Sessions provider. */
export class SessionsAgentSessionService implements IAgentSessionService {
	constructor(@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService) {}
	private async run<T>(
		sessionId: string | undefined,
		operation: (scope: ISessionProviderScope) => Promise<T>,
	): Promise<T> {
		const scope = this.scopes.getScope(sessionId);
		scope.assertCurrent();
		const result = await operation(scope);
		scope.assertCurrent();
		return result;
	}
	get invokeRuntime(): IAgentSessionService['invokeRuntime'] {
		const scope = this.scopes.getScope();
		const invoke = scope.services.host.session.invokeRuntime;
		return (
			invoke &&
			(async (...args) => {
				scope.assertCurrent();
				const result = await invoke(...args);
				scope.assertCurrent();
				return result;
			})
		);
	}
	collectDebugLogs(
		...args: Parameters<IAgentSessionService['collectDebugLogs']>
	): ReturnType<IAgentSessionService['collectDebugLogs']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.collectDebugLogs(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return result;
		});
	}
	read(...args: Parameters<IAgentSessionService['read']>): ReturnType<IAgentSessionService['read']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.read(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return projectResult(result, scope);
		});
	}
	readCatalog(
		...args: Parameters<IAgentSessionService['readCatalog']>
	): ReturnType<IAgentSessionService['readCatalog']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.readCatalog(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return { ...result, session: result.session && mapAgentSession(result.session, scope.identity) };
		});
	}
	subscribe(...args: Parameters<IAgentSessionService['subscribe']>): ReturnType<IAgentSessionService['subscribe']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.subscribe(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return {
				...projectResult(result, scope),
				threadSnapshots: result.threadSnapshots.map(snapshot => ({
					...mapAgentThreadRead(snapshot, scope.identity),
					updates: snapshot.updates.map(update => ({
						...update,
						sessionId: scope.identity(update.sessionId),
						threadId: scope.identity(update.threadId),
					})),
				})),
			};
		});
	}
	unsubscribe(
		...args: Parameters<IAgentSessionService['unsubscribe']>
	): ReturnType<IAgentSessionService['unsubscribe']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.unsubscribe(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return result;
		});
	}
	createThread(
		...args: Parameters<IAgentSessionService['createThread']>
	): ReturnType<IAgentSessionService['createThread']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.createThread(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return {
				...result,
				session: mapAgentSession(result.session, scope.identity),
				threadId: scope.identity(result.threadId),
			};
		});
	}
	archive(...args: Parameters<IAgentSessionService['archive']>): ReturnType<IAgentSessionService['archive']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.archive(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return projectResult(result, scope);
		});
	}
	rename(...args: Parameters<IAgentSessionService['rename']>): ReturnType<IAgentSessionService['rename']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.rename(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return projectResult(result, scope);
		});
	}
	delete(...args: Parameters<IAgentSessionService['delete']>): ReturnType<IAgentSessionService['delete']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.delete(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return result;
		});
	}
	restore(...args: Parameters<IAgentSessionService['restore']>): ReturnType<IAgentSessionService['restore']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.restore(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return projectResult(result, scope);
		});
	}
	stop(...args: Parameters<IAgentSessionService['stop']>): ReturnType<IAgentSessionService['stop']> {
		return this.run(args[0].sessionId, async scope => {
			const [params, ...rest] = args;
			const result = await scope.services.host.session.stop(
				{ ...params, sessionId: scope.backendIdentity(params.sessionId) },
				...rest,
			);
			return projectResult(result, scope);
		});
	}
	create(...args: Parameters<IAgentSessionService['create']>): ReturnType<IAgentSessionService['create']> {
		return this.run(undefined, async scope => {
			const result = await scope.services.host.session.create(...args);
			return projectResult(result, scope);
		});
	}
	list(...args: Parameters<IAgentSessionService['list']>): ReturnType<IAgentSessionService['list']> {
		return this.run(undefined, async scope => {
			const result = await scope.services.host.session.list(...args);
			return { ...result, sessions: result.sessions.map(session => mapAgentSession(session, scope.identity)) };
		});
	}
	subscribeCatalog(
		...args: Parameters<IAgentSessionService['subscribeCatalog']>
	): ReturnType<IAgentSessionService['subscribeCatalog']> {
		return this.run(undefined, async scope => {
			const result = await scope.services.host.session.subscribeCatalog(...args);
			return { ...result, sessions: result.sessions.map(session => mapAgentSession(session, scope.identity)) };
		});
	}
	unsubscribeCatalog(
		...args: Parameters<IAgentSessionService['unsubscribeCatalog']>
	): ReturnType<IAgentSessionService['unsubscribeCatalog']> {
		return this.run(undefined, async scope => {
			const result = await scope.services.host.session.unsubscribeCatalog(...args);
			return result;
		});
	}
	listAgents(
		...args: Parameters<IAgentSessionService['listAgents']>
	): ReturnType<IAgentSessionService['listAgents']> {
		return this.run(undefined, async scope => {
			const result = await scope.services.host.session.listAgents(...args);
			return result;
		});
	}
}
function projectResult<T extends SessionResult>(value: T, scope: ISessionProviderScope): T {
	return {
		...value,
		session: mapAgentSession(value.session, scope.identity),
		agentTree: {
			...value.agentTree,
			roots: value.agentTree.roots.map(node => mapAgentExecutionNode(node, scope.identity)),
		},
	};
}
