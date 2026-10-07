import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';

/** Read-only durable facts. Unknown envelope fields survive export without becoming UI state. */
export interface AgentTraceEvent {
	readonly eventId: string;
	readonly sequence: number;
	readonly recordedAt: number;
	readonly event: Readonly<Record<string, unknown>> & { readonly type: string; readonly threadId: string; };
}

export interface AgentTrace {
	readonly formatVersion: 3;
	readonly sessionId: string;
	readonly threads: readonly { readonly threadId: string; readonly events: readonly AgentTraceEvent[]; }[];
	readonly historyPrefixes: readonly unknown[];
	readonly diagnostics?: AgentTraceDiagnostics;
	readonly graph?: AgentTraceGraph;
}

export interface AgentTracePayloadRef {
	readonly payloadId: string;
	readonly kind: 'coreRequest' | 'materializedRequest' | 'modelResponse' | 'partialOutput';
	readonly byteLength: number;
	readonly status: 'saved' | 'omitted';
	readonly digest: string | null;
}

export interface AgentTraceDiagnosticEvent {
	readonly eventId: string;
	readonly sequence: number;
	readonly recordedAt: number;
	readonly threadId: string;
	readonly turnId: string;
	readonly event: Readonly<Record<string, unknown>> & { readonly type: string; readonly attemptId: string; };
}

export interface AgentTraceDiagnostics {
	readonly formatVersion: 1;
	readonly captureId: string | null;
	readonly recordingStatus: 'disabled' | 'recording' | 'incomplete' | 'unavailable';
	readonly droppedRecords: number;
	readonly events: readonly AgentTraceDiagnosticEvent[];
	readonly payloads?: Readonly<Record<string, unknown>>;
}

export interface AgentTraceDiagnosticPage {
	readonly diagnostics: AgentTraceDiagnostics;
	readonly cursor: number;
	readonly hasMore: boolean;
}

export interface AgentTraceNode {
	readonly id: string;
	readonly kind: string;
	readonly label: string;
	readonly threadId: string;
	readonly turnId: string | null;
	readonly eventKey: string | null;
}

export interface AgentTraceGraph {
	readonly nodes: Readonly<Record<string, AgentTraceNode>>;
	readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string; }[];
	readonly warnings: readonly string[];
}

export function diagnosticPayload(record: AgentTraceDiagnosticEvent): AgentTracePayloadRef | undefined {
	const value = record.event.requestPayload ?? record.event.responsePayload ?? record.event.partialOutput;
	if (value === undefined || value === null) { return undefined; }
	if (!isRecord(value) || typeof value.payloadId !== 'string' || !/^payload-[1-9]\d*$/.test(value.payloadId) || !['coreRequest', 'materializedRequest', 'modelResponse', 'partialOutput'].includes(String(value.kind)) || !integer(value.byteLength) || value.byteLength > 8 * 1024 * 1024 || !['saved', 'omitted'].includes(String(value.status)) || (value.status === 'saved' && (typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.digest)))) { return invalidDiagnostics(); }
	return value as unknown as AgentTracePayloadRef;
}

function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function invalidDiagnostics(): never { throw new Error(localize('agentTrace.invalidDiagnostics', 'Invalid diagnostic evidence or pagination progress.')); }

export function parseAgentTraceDiagnostics(value: unknown): AgentTraceDiagnostics {
	if (!isRecord(value) || value.formatVersion !== 1 || (value.captureId !== null && (typeof value.captureId !== 'string' || !value.captureId)) || !['disabled', 'recording', 'incomplete', 'unavailable'].includes(String(value.recordingStatus)) || !integer(value.droppedRecords) || !Array.isArray(value.events) || value.events.length > 32_000 || (value.payloads !== undefined && !isRecord(value.payloads))) { return invalidDiagnostics(); }
	let previous = 0;
	const identities = new Set<string>();
	const payloads = new Set<string>();
	for (const record of value.events) {
		if (!isRecord(record) || typeof record.eventId !== 'string' || !record.eventId || identities.has(record.eventId) || !integer(record.sequence) || record.sequence <= previous || !integer(record.recordedAt) || record.recordedAt > 8_640_000_000_000_000 || typeof record.threadId !== 'string' || !record.threadId || typeof record.turnId !== 'string' || !record.turnId || !isRecord(record.event) || !['modelAttemptStarted', 'modelRequestPrepared', 'modelAttemptCompleted', 'modelAttemptFailed', 'modelAttemptCancelled', 'modelAttemptAbandoned'].includes(String(record.event.type)) || typeof record.event.attemptId !== 'string' || !record.event.attemptId) { return invalidDiagnostics(); }
		const event = record as unknown as AgentTraceDiagnosticEvent;
		const payload = diagnosticPayload(event);
		if (['modelAttemptStarted', 'modelRequestPrepared', 'modelAttemptCompleted'].includes(event.event.type) && !payload) { return invalidDiagnostics(); }
		if (payload?.status === 'saved') { payloads.add(payload.payloadId); }
		identities.add(record.eventId);
		previous = record.sequence;
	}
	if (value.events.length && !value.captureId) { return invalidDiagnostics(); }
	if (value.payloads && Object.keys(value.payloads).some(id => !payloads.has(id))) { return invalidDiagnostics(); }
	return value as unknown as AgentTraceDiagnostics;
}

export function parseAgentTraceDiagnosticPage(value: unknown, cursor: unknown, hasMore: unknown, after: number): AgentTraceDiagnosticPage {
	const diagnostics = parseAgentTraceDiagnostics(value);
	if (!integer(cursor) || typeof hasMore !== 'boolean' || cursor !== (diagnostics.events.at(-1)?.sequence ?? after) || diagnostics.events.some(event => event.sequence <= after) || (hasMore && cursor <= after)) { return invalidDiagnostics(); }
	return { diagnostics, cursor, hasMore };
}

export function mergeAgentTraceDiagnostics(previous: AgentTraceDiagnostics | undefined, page: AgentTraceDiagnostics): AgentTraceDiagnostics {
	if (!previous) { return page; }
	if (previous.captureId && page.captureId && previous.captureId !== page.captureId) { return invalidDiagnostics(); }
	const after = previous.events.at(-1)?.sequence ?? 0;
	return { ...page, captureId: page.captureId ?? previous.captureId, events: [...previous.events, ...page.events.filter(event => event.sequence > after)], payloads: { ...previous.payloads, ...page.payloads } };
}

export function parseAgentTraceGraph(value: unknown): AgentTraceGraph {
	const invalid = (): never => { throw new Error(localize('agentTrace.invalidGraph', 'Invalid trace relationships.')); };
	if (!isRecord(value) || !isRecord(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.warnings) || value.warnings.some(warning => typeof warning !== 'string')) { return invalid(); }
	for (const [id, node] of Object.entries(value.nodes)) {
		if (!isRecord(node) || node.id !== id || typeof node.kind !== 'string' || typeof node.label !== 'string' || typeof node.threadId !== 'string' || (node.turnId !== null && typeof node.turnId !== 'string') || (node.eventKey !== null && typeof node.eventKey !== 'string')) { return invalid(); }
	}
	for (const edge of value.edges) {
		if (!isRecord(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string' || typeof edge.kind !== 'string' || !Object.hasOwn(value.nodes, edge.from) || !Object.hasOwn(value.nodes, edge.to)) { return invalid(); }
	}
	return value as unknown as AgentTraceGraph;
}

export interface AgentTracePage {
	readonly trace: AgentTrace;
	readonly cursors: Readonly<Record<string, number>>;
	readonly hasMore: boolean;
}

/** Validates fields used by the reader for both wire pages and user-selected trace files. */
export function parseAgentTrace(value: unknown): AgentTrace {
	if (!isRecord(value) || value.formatVersion !== 3 || typeof value.sessionId !== 'string' || !value.sessionId || !Array.isArray(value.threads) || !Array.isArray(value.historyPrefixes)) {
		throw new Error(localize('agentTrace.invalidArtifact', 'Invalid execution trace. Expected rollout format version 3.'));
	}
	const ids = new Set<string>();
	for (const thread of value.threads) {
		if (!isRecord(thread) || typeof thread.threadId !== 'string' || !thread.threadId || ids.has(thread.threadId) || !Array.isArray(thread.events)) {
			throw new Error(localize('agentTrace.invalidThread', 'Invalid or duplicate trace Thread.'));
		}
		ids.add(thread.threadId);
		let previous = 0;
		for (const record of thread.events) {
			if (!isRecord(record) || typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence <= previous || typeof record.recordedAt !== 'number' || !Number.isSafeInteger(record.recordedAt) || record.recordedAt < 0 || record.recordedAt > 8_640_000_000_000_000 || typeof record.eventId !== 'string' || !isRecord(record.event) || typeof record.event.type !== 'string' || record.event.threadId !== thread.threadId) {
				throw new Error(localize('agentTrace.invalidEvent', 'Invalid trace event or Thread ordering.'));
			}
			previous = record.sequence;
		}
	}
	if (value.diagnostics !== undefined && value.diagnostics !== null) { parseAgentTraceDiagnostics(value.diagnostics); }
	if (value.graph !== undefined && value.graph !== null) { parseAgentTraceGraph(value.graph); }
	return value as unknown as AgentTrace;
}

export function mergeAgentTrace(previous: AgentTrace | undefined, page: AgentTrace): AgentTrace {
	if (!previous) { return page; }
	if (previous.sessionId !== page.sessionId) { throw new Error(localize('agentTrace.changedSession', 'Trace belongs to another conversation.')); }
	const threads = new Map(previous.threads.map(thread => [thread.threadId, thread]));
	for (const thread of page.threads) {
		const existing = threads.get(thread.threadId);
		const after = existing?.events.at(-1)?.sequence ?? 0;
		threads.set(thread.threadId, { ...thread, events: [...(existing?.events ?? []), ...thread.events.filter(record => record.sequence > after)] });
	}
	const prefixes = new Map([...previous.historyPrefixes, ...page.historyPrefixes].map(prefix => [JSON.stringify(prefix), prefix]));
	return { ...previous, ...page, historyPrefixes: [...prefixes.values()], ...(previous.diagnostics ? { diagnostics: previous.diagnostics } : {}), ...(previous.graph ? { graph: page.threads.some(thread => thread.events.length) ? undefined : previous.graph } : {}), threads: [...threads.values()] };
}

/** Checks pagination progress before a reader can advance its durable cursors. */
export function parseAgentTracePage(value: unknown, cursors: unknown, hasMore: unknown, sessionId: string, after: Readonly<Record<string, number>>): AgentTracePage {
	const trace = parseAgentTrace(value);
	if (trace.sessionId !== sessionId) { throw new Error(localize('agentTrace.changedSession', 'Trace belongs to another conversation.')); }
	const invalid = (): never => { throw new Error(localize('agentTrace.invalidPage', 'Invalid trace cursors or pagination progress.')); };
	if (!isRecord(cursors) || typeof hasMore !== 'boolean' || Object.keys(cursors).length !== trace.threads.length) { return invalid(); }
	let progressed = false;
	for (const thread of trace.threads) {
		const previous = after[thread.threadId] ?? 0;
		const next = cursors[thread.threadId];
		if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < previous || next !== (thread.events.at(-1)?.sequence ?? previous) || thread.events.some(record => record.sequence <= previous)) { return invalid(); }
		progressed ||= next > previous;
	}
	if (hasMore && !progressed) { return invalid(); }
	return { trace, cursors: cursors as Readonly<Record<string, number>>, hasMore };
}
