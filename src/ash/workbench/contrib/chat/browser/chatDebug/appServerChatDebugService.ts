import { localize } from '../../../../../nls.js';
import type { AgentWireLogFrame } from '../../../../../platform/agentHost/common/agent.js';
import { IAgentSessionService, IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IChatDebugService } from '../../common/chatDebugService.js';
import type { AgentTracePage, AgentTraceDiagnosticPage, AgentTraceGraph } from '../../common/chatDebugEvents.js';

/** Borrows the canonical transport. Parsers load only when evidence is requested. */
export class AppServerChatDebugService extends Disposable implements IChatDebugService {
	private readonly availableSessionsChanged = this._register(new Emitter<void>());
	readonly onDidChangeAvailableSessionResources = this.availableSessionsChanged.event;
	private available: readonly URI[] = [];
	private titles = new Map<string, string>();
	private catalogRevision = 0;

	constructor(
		@IAgentThreadService private readonly threads: IAgentThreadService,
		@IAgentSessionService private readonly sessions: IAgentSessionService,
	) { super(); }

	getAvailableSessionResources(): readonly URI[] { return this.available; }
	getHistoricalSessionTitle(sessionResource: URI): string | undefined { return this.titles.get(sessionResource.toString()); }

	async refreshAvailableSessions(): Promise<void> {
		const revision = ++this.catalogRevision;
		const { sessions } = await this.sessions.list();
		if (this.isDisposed || revision !== this.catalogRevision) { return; }
		// These are catalog labels only. Durable events, usage and relationships stay in App Server.
		this.available = sessions.map(session => URI.from({ scheme: 'ash-agent-trace', path: `/${session.sessionId}` }));
		this.titles = new Map(sessions.map((session, index) => [this.available[index].toString(), session.title]));
		this.availableSessionsChanged.fire();
	}

	async readSession(sessionId: string) { return (await this.sessions.read({ sessionId })).session; }

	public async readTrace(sessionId: string, after: Readonly<Record<string, number>>): Promise<AgentTracePage> {
		const [{ parseAgentTracePage }, page] = await Promise.all([import('../../common/chatDebugEvents.js'), this.threads.readTrace({ sessionId, after: { ...after }, limit: 500 })]);
		return parseAgentTracePage(page.trace, page.cursors, page.hasMore, sessionId, after);
	}

	public async readTraceDiagnostics(sessionId: string, after: number): Promise<AgentTraceDiagnosticPage> {
		const [{ parseAgentTraceDiagnosticPage }, page] = await Promise.all([import('../../common/chatDebugEvents.js'), this.threads.readTraceDiagnostics({ sessionId, after, limit: 500 })]);
		return parseAgentTraceDiagnosticPage(page.diagnostics, page.cursor, page.hasMore, after);
	}

	public async readTracePayload(sessionId: string, captureId: string, payloadId: string): Promise<unknown> {
		return (await this.threads.readTracePayload({ sessionId, captureId, payloadId })).payload;
	}

	public async readTraceGraph(sessionId: string): Promise<AgentTraceGraph> {
		const [{ parseAgentTraceGraph }, page] = await Promise.all([import('../../common/chatDebugEvents.js'), this.threads.readTraceGraph({ sessionId })]);
		return parseAgentTraceGraph(page.graph);
	}
	startWireLog(sessionId: string, captureId: string): Promise<void> { return this.threads.startWireLog({ sessionId, captureId }); }
	stopWireLog(sessionId: string, captureId: string): Promise<void> { return this.threads.stopWireLog({ sessionId, captureId }); }
	readWireLog(sessionId: string, captureId: string, after: number) { return this.threads.readWireLog({ sessionId, captureId, after, limit: 100 }); }

	async exportWireLog(sessionId: string, captureId: string): Promise<Uint8Array> {
		await this.threads.stopWireLog({ sessionId, captureId });
		const frames: AgentWireLogFrame[] = [];
		let after = 0;
		// A stopped backend buffer contains at most 2000 frames / 2 MiB of raw text.
		for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
			const page = await this.readWireLog(sessionId, captureId, after);
			if (page.recording) { throw new Error(localize('chatDebug.wireExportActive', 'The capture is still recording. Stop it before exporting.')); }
			frames.push(...page.frames);
			if (!page.hasMore) {
				return new TextEncoder().encode(JSON.stringify({ formatVersion: 1, scope: 'appServerConnection', captureId: page.captureId, connectionId: page.connectionId, droppedFrames: page.droppedFrames, frames }, null, 2));
			}
			after = page.cursor;
		}
		throw new Error(localize('chatDebug.wireExportIncomplete', 'The backend capture could not be fully read. No partial export was saved.'));
	}

}
