import type { AgentSession, AgentWireLogPage } from '../../../../platform/agentHost/common/agent.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { AgentTracePage, AgentTraceDiagnosticPage, AgentTraceGraph } from './chatDebugEvents.js';
import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';

export const IChatDebugService = createServiceIdentifier<IChatDebugService>('chatDebugService');

/** Catalog, read-only evidence and opt-in connection diagnostics over the existing backend connection. Execution and durable data stay in the backend. */
export interface IChatDebugService {
	readonly onDidChangeAvailableSessionResources: Event<void>;
	getAvailableSessionResources(): readonly URI[];
	getHistoricalSessionTitle(sessionResource: URI): string | undefined;
	/** Refreshes a presentation snapshot from the owning backend catalog, without reading captures. */
	refreshAvailableSessions(): Promise<void>;
	/** Current backend metadata; independent of the historical capture. */
	readSession(sessionId: string): Promise<AgentSession>;
	readTrace(sessionId: string, after: Readonly<Record<string, number>>): Promise<AgentTracePage>;
	readTraceDiagnostics(sessionId: string, after: number): Promise<AgentTraceDiagnosticPage>;
	readTracePayload(sessionId: string, captureId: string, payloadId: string): Promise<unknown>;
	readTraceGraph(sessionId: string): Promise<AgentTraceGraph>;
	startWireLog(sessionId: string, captureId: string): Promise<void>;
	stopWireLog(sessionId: string, captureId: string): Promise<void>;
	/** Stops capture and exports every retained backend frame, independently of display filters. */
	exportWireLog(sessionId: string, captureId: string): Promise<Uint8Array>;
	readWireLog(sessionId: string, captureId: string, after: number): Promise<AgentWireLogPage>;
}
