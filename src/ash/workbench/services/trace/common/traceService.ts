import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { AgentTracePage, AgentTraceDiagnosticPage, AgentTraceGraph } from './agentTrace.js';

export const ITraceService = createServiceIdentifier<ITraceService>('traceService');

/** Read-only evidence over the existing backend connection; owns no execution or subscriptions. */
export interface ITraceService {
	readTrace(sessionId: string, after: Readonly<Record<string, number>>): Promise<AgentTracePage>;
	readTraceDiagnostics(sessionId: string, after: number): Promise<AgentTraceDiagnosticPage>;
	readTracePayload(sessionId: string, captureId: string, payloadId: string): Promise<unknown>;
	readTraceGraph(sessionId: string): Promise<AgentTraceGraph>;
}
