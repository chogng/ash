import { IThreadApi } from '../../../../platform/sessions/common/sessionApi.js';
import type { ITraceService } from '../common/traceService.js';
import type { AgentTracePage, AgentTraceDiagnosticPage, AgentTraceGraph } from '../common/agentTrace.js';

/** Borrows the canonical transport. Parsers load only when evidence is requested. */
export class AppServerTraceService implements ITraceService {
	constructor(@IThreadApi private readonly threads: IThreadApi) { }

	public async readTrace(sessionId: string, after: Readonly<Record<string, number>>): Promise<AgentTracePage> {
		const [{ parseAgentTracePage }, page] = await Promise.all([import('../common/agentTrace.js'), this.threads.readTrace({ sessionId, after: { ...after }, limit: 500 })]);
		return parseAgentTracePage(page.trace, page.cursors, page.hasMore, sessionId, after);
	}

	public async readTraceDiagnostics(sessionId: string, after: number): Promise<AgentTraceDiagnosticPage> {
		const [{ parseAgentTraceDiagnosticPage }, page] = await Promise.all([import('../common/agentTrace.js'), this.threads.readTraceDiagnostics({ sessionId, after, limit: 500 })]);
		return parseAgentTraceDiagnosticPage(page.diagnostics, page.cursor, page.hasMore, after);
	}

	public async readTracePayload(sessionId: string, captureId: string, payloadId: string): Promise<unknown> {
		return (await this.threads.readTracePayload({ sessionId, captureId, payloadId })).payload;
	}

	public async readTraceGraph(sessionId: string): Promise<AgentTraceGraph> {
		const [{ parseAgentTraceGraph }, page] = await Promise.all([import('../common/agentTrace.js'), this.threads.readTraceGraph({ sessionId })]);
		return parseAgentTraceGraph(page.graph);
	}
}
