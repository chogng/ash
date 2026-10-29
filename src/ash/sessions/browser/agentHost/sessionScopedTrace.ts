import type { ISessionProviderScope } from './sessionProviderScopeService.js';
import { isRecord } from '../../../base/common/types.js';
import {
	parseAgentTracePage,
	parseAgentTraceDiagnostics,
	parseAgentTraceGraph,
	type AgentTrace,
	type AgentTraceDiagnostics,
	type AgentTraceGraph,
} from '../../../workbench/contrib/chat/common/chatDebugEvents.js';
import type { SessionTraceReadResult } from '../../../platform/agentHost/common/agent.js';

/** Project only presentation identities; payload bodies, event keys and graph edges remain evidence. */
function graph(scope: ISessionProviderScope, value: AgentTraceGraph): AgentTraceGraph {
	return {
		...value,
		nodes: Object.fromEntries(Object.entries(value.nodes).map(([id, node]) => [id, { ...node, threadId: scope.identity(node.threadId) }])),
	};
}

function diagnostics(scope: ISessionProviderScope, value: AgentTraceDiagnostics): AgentTraceDiagnostics {
	return { ...value, events: value.events.map(record => ({ ...record, threadId: scope.identity(record.threadId) })) };
}

function trace(scope: ISessionProviderScope, value: AgentTrace): AgentTrace {
	return {
		...value,
		sessionId: scope.identity(value.sessionId),
		threads: value.threads.map(thread => ({
			...thread,
			threadId: scope.identity(thread.threadId),
			events: thread.events.map(record => {
				const origin = record.event.origin;
				return {
					...record,
					event: {
						...record.event,
						threadId: scope.identity(record.event.threadId),
						...(isRecord(origin)
							? {
									origin: {
										...origin,
										...(typeof origin.parentThreadId === 'string' ? { parentThreadId: scope.identity(origin.parentThreadId) } : {}),
										...(typeof origin.sourceThreadId === 'string' ? { sourceThreadId: scope.identity(origin.sourceThreadId) } : {}),
									},
								}
							: {}),
					},
				};
			}),
		})),
		...(value.overview
			? {
					overview: {
						...value.overview,
						threadCursors: Object.fromEntries(Object.entries(value.overview.threadCursors).map(([id, cursor]) => [scope.identity(id), cursor])),
					},
				}
			: {}),
		...(value.diagnostics ? { diagnostics: diagnostics(scope, value.diagnostics) } : {}),
		...(value.graph ? { graph: graph(scope, value.graph) } : {}),
	};
}

export function projectSessionTrace(scope: ISessionProviderScope, result: SessionTraceReadResult, backendSessionId: string, after: Readonly<Record<string, number>>): SessionTraceReadResult {
	const page = parseAgentTracePage(result.trace, result.cursors, result.hasMore, backendSessionId, after);
	return {
		...result,
		trace: trace(scope, page.trace),
		cursors: Object.fromEntries(Object.entries(page.cursors).map(([id, cursor]) => [scope.identity(id), cursor])),
	};
}

export function projectSessionDiagnostics(scope: ISessionProviderScope, value: unknown): AgentTraceDiagnostics {
	return diagnostics(scope, parseAgentTraceDiagnostics(value));
}
export function projectSessionTraceGraph(scope: ISessionProviderScope, value: unknown): AgentTraceGraph {
	return graph(scope, parseAgentTraceGraph(value));
}
