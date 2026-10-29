import type { IAgentThreadService } from '../../../platform/agentHost/common/agentService.js';
import type { ISessionProviderScope } from './sessionProviderScopeService.js';
import { Event } from '../../../base/common/event.js';

/** Backend ports remain raw; scoped UI operations cannot accidentally use the ambient connection. */
export function createSessionThreadService(scope: ISessionProviderScope): IAgentThreadService {
	const backend = scope.services.host.thread;
	const identity = <T extends { readonly sessionId: string; readonly threadId: string }>(value: T): T => ({
		...value,
		sessionId: scope.identity(value.sessionId),
		threadId: scope.identity(value.threadId),
	});
	const params = <T extends { readonly sessionId: string; readonly threadId?: string }>(value: T): T => ({
		...value,
		sessionId: scope.backendIdentity(value.sessionId),
		...('threadId' in value && value.threadId !== undefined ? { threadId: scope.backendIdentity(value.threadId) } : {}),
	});
	const run = async <T>(operation: () => Promise<T>): Promise<T> => {
		scope.assertCurrent();
		const result = await operation();
		scope.assertCurrent();
		return result;
	};
	return {
		onDidChangeConnection: backend.onDidChangeConnection,
		onDidOfferInteraction: Event.map(backend.onDidOfferInteraction, identity),
		onDidUpdateThread: Event.map(backend.onDidUpdateThread, identity),
		onDidUpdateThreadTranscript: Event.map(backend.onDidUpdateThreadTranscript, identity),
		fork: (...args: Parameters<IAgentThreadService['fork']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.fork(params(source), ...rest);
				return identity(result);
			}),
		rewrite: (...args: Parameters<IAgentThreadService['rewrite']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.rewrite(params(source), ...rest);
				return identity(result);
			}),
		rename: (...args: Parameters<IAgentThreadService['rename']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.rename(params(source), ...rest);
				return result;
			}),
		readAttachment: (...args: Parameters<IAgentThreadService['readAttachment']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.readAttachment(params(source), ...rest);
				return result;
			}),
		listAppTools: (...args: Parameters<IAgentThreadService['listAppTools']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.listAppTools(params(source), ...rest);
				return result;
			}),
		invokeAppTool: (...args: Parameters<IAgentThreadService['invokeAppTool']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.invokeAppTool(params(source), ...rest);
				return result;
			}),
		readToolResource: (...args: Parameters<IAgentThreadService['readToolResource']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.readToolResource(params(source), ...rest);
				return result;
			}),
		readAppResource: (...args: Parameters<IAgentThreadService['readAppResource']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.readAppResource(params(source), ...rest);
				return result;
			}),
		readHistoryState: (...args: Parameters<IAgentThreadService['readHistoryState']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.readHistoryState(params(source), ...rest);
				return result;
			}),
		moveHistory: (...args: Parameters<IAgentThreadService['moveHistory']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.moveHistory(params(source), ...rest);
				return result;
			}),
		readContext: (...args: Parameters<IAgentThreadService['readContext']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.readContext(params(source), ...rest);
				return result;
			}),
		checkpoints: (...args: Parameters<IAgentThreadService['checkpoints']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.checkpoints(params(source), ...rest);
				return result;
			}),
		restoreMessage: (...args: Parameters<IAgentThreadService['restoreMessage']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.restoreMessage(params(source), ...rest);
				return identity(result);
			}),
		readTrace: (...args: Parameters<IAgentThreadService['readTrace']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const request = {
					...params(source),
					after: Object.fromEntries(Object.entries(source.after).map(([id, cursor]) => [scope.backendIdentity(id), cursor])),
				};
				const result = await backend.readTrace(request, ...rest);
				const { projectSessionTrace } = await import('./sessionScopedTrace.js');
				return projectSessionTrace(scope, result, request.sessionId, request.after);
			}),
		readTraceDiagnostics: (...args: Parameters<IAgentThreadService['readTraceDiagnostics']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.readTraceDiagnostics(params(source), ...rest);
				const { projectSessionDiagnostics } = await import('./sessionScopedTrace.js');
				return { ...result, diagnostics: projectSessionDiagnostics(scope, result.diagnostics) };
			}),
		readTracePayload: (...args: Parameters<IAgentThreadService['readTracePayload']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.readTracePayload(params(source), ...rest);
				return result;
			}),
		readTraceGraph: (...args: Parameters<IAgentThreadService['readTraceGraph']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.readTraceGraph(params(source), ...rest);
				const { projectSessionTraceGraph } = await import('./sessionScopedTrace.js');
				return { ...result, graph: projectSessionTraceGraph(scope, result.graph) };
			}),
		configureAdvisor: (...args: Parameters<IAgentThreadService['configureAdvisor']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.configureAdvisor(params(source), ...rest);
				return result;
			}),
		read: (...args: Parameters<IAgentThreadService['read']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.read(params(source), ...rest);
				return {
					...result,
					thread: {
						...identity(result.thread),
						origin:
							result.thread.origin.type === 'root'
								? result.thread.origin
								: result.thread.origin.type === 'replacement'
									? {
											...result.thread.origin,
											sourceThreadId: scope.identity(result.thread.origin.sourceThreadId),
										}
									: {
											...result.thread.origin,
											parentThreadId: scope.identity(result.thread.origin.parentThreadId),
										},
						goal: result.thread.goal && {
							...result.thread.goal,
							threadId: scope.identity(result.thread.goal.threadId),
						},
					},
					transcript: identity(result.transcript),
				};
			}),
		subscribe: (...args: Parameters<IAgentThreadService['subscribe']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.subscribe(params(source), ...rest);
				return {
					...result,
					thread: {
						...identity(result.thread),
						origin:
							result.thread.origin.type === 'root'
								? result.thread.origin
								: result.thread.origin.type === 'replacement'
									? {
											...result.thread.origin,
											sourceThreadId: scope.identity(result.thread.origin.sourceThreadId),
										}
									: {
											...result.thread.origin,
											parentThreadId: scope.identity(result.thread.origin.parentThreadId),
										},
						goal: result.thread.goal && {
							...result.thread.goal,
							threadId: scope.identity(result.thread.goal.threadId),
						},
					},
					transcript: identity(result.transcript),
					updates: result.updates.map(identity),
				};
			}),
		unsubscribe: (...args: Parameters<IAgentThreadService['unsubscribe']>) =>
			run(async () => {
				const [source, ...rest] = args;
				const result = await backend.unsubscribe(params(source), ...rest);
				return result;
			}),
	};
}
