import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';

/** Read-only durable facts. Unknown envelope fields survive export without becoming UI state. */
export interface AgentTraceEvent {
	readonly eventId: string;
	readonly sequence: number;
	readonly recordedAt: number;
	readonly event: Readonly<Record<string, unknown>> & { readonly type: string; readonly threadId: string };
}

export interface AgentTrace {
	readonly formatVersion: 3;
	readonly sessionId: string;
	readonly threads: readonly { readonly threadId: string; readonly events: readonly AgentTraceEvent[] }[];
	readonly historyPrefixes: readonly unknown[];
	readonly diagnostics?: AgentTraceDiagnostics;
	readonly graph?: AgentTraceGraph;
	readonly overview?: AgentTraceOverview;
	readonly performance?: AgentTracePerformance;
}

export type PerformanceUnknownReason =
	| 'missingTiming'
	| 'noTextDeltas'
	| 'inconsistentTiming'
	| 'requestNotCompleted'
	| 'singleTextDelta'
	| 'toolOutput'
	| 'missingUsage'
	| 'missingOutputTokens'
	| 'missingReasoningTokens'
	| 'inconsistentTokenUsage'
	| 'noTextOutputTokens'
	| 'zeroGenerationDuration';
export type PerformanceDuration =
	| { readonly type: 'measured'; readonly microseconds: string }
	| { readonly type: 'unknown'; readonly reason: PerformanceUnknownReason };
export type PerformanceRate =
	| { readonly type: 'estimated'; readonly tokensPerSecond: string }
	| { readonly type: 'unknown'; readonly reason: PerformanceUnknownReason };

/** Backend projections over exact durable events. Presentation never derives eligibility or TPS. */
export interface InvocationPerformance {
	readonly threadId: string;
	readonly turnId: string;
	readonly eventId: string;
	readonly invocationId: string;
	readonly total: PerformanceDuration;
	readonly firstText: PerformanceDuration;
	readonly generation: PerformanceDuration;
	readonly textTps: PerformanceRate;
}

export interface AgentTracePerformance {
	readonly formatVersion: 1;
	readonly calls: readonly InvocationPerformance[];
}

export function performanceKey(threadId: string, eventId: string): string {
	return JSON.stringify([threadId, eventId]);
}

function parsePerformance(value: unknown, threads: AgentTrace['threads']): AgentTracePerformance {
	const invalid = (): never => {
		throw new Error(
			localize('chatDebug.invalidPerformance', 'Invalid model performance projection or event identity.'),
		);
	};
	if (!isRecord(value) || value.formatVersion !== 1 || !Array.isArray(value.calls)) {
		return invalid();
	}
	const reasons = new Set<PerformanceUnknownReason>([
		'missingTiming',
		'noTextDeltas',
		'inconsistentTiming',
		'requestNotCompleted',
		'singleTextDelta',
		'toolOutput',
		'missingUsage',
		'missingOutputTokens',
		'missingReasoningTokens',
		'inconsistentTokenUsage',
		'noTextOutputTokens',
		'zeroGenerationDuration',
	]);
	const unknown = (metric: Record<string, unknown>) =>
		metric.type === 'unknown' && reasons.has(metric.reason as PerformanceUnknownReason);
	const events = new Map(
		threads.flatMap(thread =>
			thread.events
				.filter(record => record.event.type === 'modelInvocationRecorded')
				.map(record => [performanceKey(thread.threadId, record.eventId), record] as const),
		),
	);
	const seen = new Set<string>();
	for (const call of value.calls) {
		if (
			!isRecord(call) ||
			typeof call.threadId !== 'string' ||
			typeof call.eventId !== 'string' ||
			typeof call.turnId !== 'string' ||
			typeof call.invocationId !== 'string'
		) {
			return invalid();
		}
		const key = performanceKey(call.threadId, call.eventId);
		const event = events.get(key)?.event;
		const record = isRecord(event?.record) ? event.record : undefined;
		if (
			!record ||
			seen.has(key) ||
			call.turnId !== event?.turnId ||
			call.invocationId !== record.invocationId ||
			record.threadId !== call.threadId ||
			record.turnId !== call.turnId
		) {
			return invalid();
		}
		seen.add(key);
		for (const name of ['total', 'firstText', 'generation']) {
			const metric = call[name];
			if (
				!isRecord(metric) ||
				(!unknown(metric) &&
					!(
						metric.type === 'measured' &&
						typeof metric.microseconds === 'string' &&
						/^(0|[1-9]\d{0,19})$/.test(metric.microseconds) &&
						BigInt(metric.microseconds) <= 18_446_744_073_709_551_615n
					))
			) {
				return invalid();
			}
		}
		const rate = call.textTps;
		if (
			!isRecord(rate) ||
			(!unknown(rate) &&
				!(
					rate.type === 'estimated' &&
					typeof rate.tokensPerSecond === 'string' &&
					/^(0|[1-9]\d{0,25})\.\d$/.test(rate.tokensPerSecond)
				))
		) {
			return invalid();
		}
	}
	return value as unknown as AgentTracePerformance;
}

export interface AgentTraceMetric {
	readonly reported: string | null;
	readonly reportedCalls: number;
	readonly missingCalls: number;
}

/** Backend-derived accounting scoped to these exact durable prefixes, never a second ledger. */
export interface AgentTraceOverview {
	readonly formatVersion: 1;
	readonly threadCursors: Readonly<Record<string, number>>;
	readonly eventCount: number;
	readonly modelCalls: number;
	readonly toolCalls: number;
	readonly failedModelCalls: number;
	readonly cancelledModelCalls: number;
	readonly excludedModelCalls: number;
	readonly inputTokens: AgentTraceMetric;
	readonly outputTokens: AgentTraceMetric;
	readonly cachedInputTokens: AgentTraceMetric;
	readonly totalTokens: AgentTraceMetric;
}

function parseOverview(value: unknown): AgentTraceOverview {
	const invalid = (): never => {
		throw new Error(localize('chatDebug.invalidOverview', 'Invalid execution overview or metric coverage.'));
	};
	if (
		!isRecord(value) ||
		value.formatVersion !== 1 ||
		!isRecord(value.threadCursors) ||
		!Object.values(value.threadCursors).every(integer)
	) {
		return invalid();
	}
	for (const key of [
		'eventCount',
		'modelCalls',
		'toolCalls',
		'failedModelCalls',
		'cancelledModelCalls',
		'excludedModelCalls',
	]) {
		if (!integer(value[key])) {
			return invalid();
		}
	}
	if ((value.failedModelCalls as number) + (value.cancelledModelCalls as number) > (value.modelCalls as number)) {
		return invalid();
	}
	for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens']) {
		const metric = value[key];
		if (!isRecord(metric) || !integer(metric.reportedCalls) || !integer(metric.missingCalls)) {
			return invalid();
		}
		if (metric.reportedCalls + metric.missingCalls !== value.modelCalls) {
			return invalid();
		}
		if (metric.reportedCalls === 0) {
			if (metric.reported !== null) {
				return invalid();
			}
		} else if (typeof metric.reported !== 'string' || !/^(0|[1-9]\d{0,38})$/.test(metric.reported)) {
			return invalid();
		}
	}
	return value as unknown as AgentTraceOverview;
}

/** Older or stale summaries stay unavailable instead of invoking a second analyzer. */
export function traceOverview(trace: AgentTrace): AgentTraceOverview | undefined {
	const overview = trace.overview;
	if (
		!overview ||
		Object.keys(overview.threadCursors).length !== trace.threads.length ||
		overview.eventCount !== trace.threads.reduce((count, thread) => count + thread.events.length, 0)
	) {
		return undefined;
	}
	return trace.threads.every(
		thread => overview.threadCursors[thread.threadId] === (thread.events.at(-1)?.sequence ?? 0),
	)
		? overview
		: undefined;
}

export interface AgentTracePayloadRef {
	readonly payloadId: string;
	readonly kind: 'coreRequest' | 'materializedRequest' | 'modelResponse' | 'partialOutput' | 'hookExecution';
	readonly byteLength: number;
	readonly status: 'saved' | 'omitted';
	readonly digest: string | null;
}

export interface AgentTraceDiagnosticEvent {
	readonly eventId: string;
	readonly sequence: number;
	readonly recordedAt: number;
	readonly threadId: string;
	readonly turnId: string | null;
	readonly event: Readonly<Record<string, unknown>> & { readonly type: string };
}

export interface AgentTraceDiagnostics {
	readonly formatVersion: 1 | 2;
	readonly captureId: string | null;
	readonly recordingStatus: 'disabled' | 'recording' | 'incomplete' | 'unavailable';
	readonly droppedRecords: number;
	readonly pendingRecords?: number;
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
	readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: string }[];
	readonly warnings: readonly string[];
}

export function diagnosticPayload(record: AgentTraceDiagnosticEvent): AgentTracePayloadRef | undefined {
	const value =
		record.event.requestPayload ??
		record.event.responsePayload ??
		record.event.partialOutput ??
		record.event.executionPayload;
	if (value === undefined || value === null) {
		return undefined;
	}
	if (
		!isRecord(value) ||
		typeof value.payloadId !== 'string' ||
		!/^payload-[1-9]\d*$/.test(value.payloadId) ||
		!['coreRequest', 'materializedRequest', 'modelResponse', 'partialOutput', 'hookExecution'].includes(
			String(value.kind),
		) ||
		!integer(value.byteLength) ||
		value.byteLength > 8 * 1024 * 1024 ||
		!['saved', 'omitted'].includes(String(value.status)) ||
		(value.status === 'saved' && (typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.digest)))
	) {
		return invalidDiagnostics();
	}
	return value as unknown as AgentTracePayloadRef;
}

function integer(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function invalidDiagnostics(): never {
	throw new Error(localize('agentTrace.invalidDiagnostics', 'Invalid diagnostic evidence or pagination progress.'));
}

export function parseAgentTraceDiagnostics(value: unknown): AgentTraceDiagnostics {
	if (
		!isRecord(value) ||
		(value.formatVersion !== 1 && value.formatVersion !== 2) ||
		(value.captureId !== null && (typeof value.captureId !== 'string' || !value.captureId)) ||
		!['disabled', 'recording', 'incomplete', 'unavailable'].includes(String(value.recordingStatus)) ||
		!integer(value.droppedRecords) ||
		((value.formatVersion === 2 || value.pendingRecords !== undefined) && !integer(value.pendingRecords)) ||
		!Array.isArray(value.events) ||
		value.events.length > 32_000 ||
		(value.payloads !== undefined && !isRecord(value.payloads))
	) {
		return invalidDiagnostics();
	}
	let previous = 0;
	const identities = new Set<string>();
	const payloads = new Set<string>();
	for (const record of value.events) {
		if (
			!isRecord(record) ||
			typeof record.eventId !== 'string' ||
			!record.eventId ||
			identities.has(record.eventId) ||
			!integer(record.sequence) ||
			record.sequence <= previous ||
			!integer(record.recordedAt) ||
			record.recordedAt > 8_640_000_000_000_000 ||
			typeof record.threadId !== 'string' ||
			!record.threadId ||
			(record.turnId !== null && (typeof record.turnId !== 'string' || !record.turnId)) ||
			!isRecord(record.event) ||
			![
				'modelAttemptStarted',
				'modelRequestPrepared',
				'modelAttemptCompleted',
				'modelAttemptFailed',
				'modelAttemptCancelled',
				'modelAttemptAbandoned',
				'modelAttemptAccounted',
				'hookRunRecorded',
			].includes(String(record.event.type))
		) {
			return invalidDiagnostics();
		}
		const event = record as unknown as AgentTraceDiagnosticEvent;
		const payload = diagnosticPayload(event);
		if (
			event.event.type === 'modelAttemptAccounted' &&
			(value.formatVersion !== 2 ||
				typeof event.event.invocationId !== 'string' ||
				!event.event.invocationId ||
				!integer(event.event.sourceThreadSequence) ||
				event.event.sourceThreadSequence === 0 ||
				payload)
		) {
			return invalidDiagnostics();
		}
		if (event.event.type === 'hookRunRecorded') {
			if (typeof event.event.runId !== 'string' || !event.event.runId || payload?.kind !== 'hookExecution') {
				return invalidDiagnostics();
			}
		} else if (typeof event.event.attemptId !== 'string' || !event.event.attemptId || event.turnId === null) {
			return invalidDiagnostics();
		}
		if (
			['modelAttemptStarted', 'modelRequestPrepared', 'modelAttemptCompleted'].includes(event.event.type) &&
			!payload
		) {
			return invalidDiagnostics();
		}
		if (payload?.status === 'saved') {
			payloads.add(payload.payloadId);
		}
		identities.add(record.eventId);
		previous = record.sequence;
	}
	if (value.events.length && !value.captureId) {
		return invalidDiagnostics();
	}
	if (value.payloads && Object.keys(value.payloads).some(id => !payloads.has(id))) {
		return invalidDiagnostics();
	}
	return value as unknown as AgentTraceDiagnostics;
}

export function parseAgentTraceDiagnosticPage(
	value: unknown,
	cursor: unknown,
	hasMore: unknown,
	after: number,
): AgentTraceDiagnosticPage {
	const diagnostics = parseAgentTraceDiagnostics(value);
	if (
		!integer(cursor) ||
		typeof hasMore !== 'boolean' ||
		cursor !== (diagnostics.events.at(-1)?.sequence ?? after) ||
		diagnostics.events.some(event => event.sequence <= after) ||
		(hasMore && cursor <= after)
	) {
		return invalidDiagnostics();
	}
	return { diagnostics, cursor, hasMore };
}

export function mergeAgentTraceDiagnostics(
	previous: AgentTraceDiagnostics | undefined,
	page: AgentTraceDiagnostics,
): AgentTraceDiagnostics {
	if (!previous) {
		return page;
	}
	if (previous.captureId && page.captureId && previous.captureId !== page.captureId) {
		return invalidDiagnostics();
	}
	const after = previous.events.at(-1)?.sequence ?? 0;
	return {
		...page,
		captureId: page.captureId ?? previous.captureId,
		events: [...previous.events, ...page.events.filter(event => event.sequence > after)],
		payloads: { ...previous.payloads, ...page.payloads },
	};
}

export function parseAgentTraceGraph(value: unknown): AgentTraceGraph {
	const invalid = (): never => {
		throw new Error(localize('agentTrace.invalidGraph', 'Invalid trace relationships.'));
	};
	if (
		!isRecord(value) ||
		!isRecord(value.nodes) ||
		!Array.isArray(value.edges) ||
		!Array.isArray(value.warnings) ||
		value.warnings.some(warning => typeof warning !== 'string')
	) {
		return invalid();
	}
	for (const [id, node] of Object.entries(value.nodes)) {
		if (
			!isRecord(node) ||
			node.id !== id ||
			typeof node.kind !== 'string' ||
			typeof node.label !== 'string' ||
			typeof node.threadId !== 'string' ||
			(node.turnId !== null && typeof node.turnId !== 'string') ||
			(node.eventKey !== null && typeof node.eventKey !== 'string')
		) {
			return invalid();
		}
	}
	for (const edge of value.edges) {
		if (
			!isRecord(edge) ||
			typeof edge.from !== 'string' ||
			typeof edge.to !== 'string' ||
			typeof edge.kind !== 'string' ||
			!Object.hasOwn(value.nodes, edge.from) ||
			!Object.hasOwn(value.nodes, edge.to)
		) {
			return invalid();
		}
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
	if (
		!isRecord(value) ||
		value.formatVersion !== 3 ||
		typeof value.sessionId !== 'string' ||
		!value.sessionId ||
		!Array.isArray(value.threads) ||
		!Array.isArray(value.historyPrefixes)
	) {
		throw new Error(
			localize('agentTrace.invalidArtifact', 'Invalid execution trace. Expected rollout format version 3.'),
		);
	}
	const ids = new Set<string>();
	for (const thread of value.threads) {
		if (
			!isRecord(thread) ||
			typeof thread.threadId !== 'string' ||
			!thread.threadId ||
			ids.has(thread.threadId) ||
			!Array.isArray(thread.events)
		) {
			throw new Error(localize('agentTrace.invalidThread', 'Invalid or duplicate trace Thread.'));
		}
		ids.add(thread.threadId);
		let previous = 0;
		for (const record of thread.events) {
			if (
				!isRecord(record) ||
				typeof record.sequence !== 'number' ||
				!Number.isSafeInteger(record.sequence) ||
				record.sequence <= previous ||
				typeof record.recordedAt !== 'number' ||
				!Number.isSafeInteger(record.recordedAt) ||
				record.recordedAt < 0 ||
				record.recordedAt > 8_640_000_000_000_000 ||
				typeof record.eventId !== 'string' ||
				!isRecord(record.event) ||
				typeof record.event.type !== 'string' ||
				record.event.threadId !== thread.threadId
			) {
				throw new Error(localize('agentTrace.invalidEvent', 'Invalid trace event or Thread ordering.'));
			}
			previous = record.sequence;
		}
	}
	if (value.diagnostics !== undefined && value.diagnostics !== null) {
		parseAgentTraceDiagnostics(value.diagnostics);
	}
	if (value.graph !== undefined && value.graph !== null) {
		parseAgentTraceGraph(value.graph);
	}
	if (value.overview !== undefined && value.overview !== null) {
		parseOverview(value.overview);
	}
	if (value.performance !== undefined && value.performance !== null) {
		parsePerformance(value.performance, value.threads as unknown as AgentTrace['threads']);
	}
	return value as unknown as AgentTrace;
}

export function mergeAgentTrace(previous: AgentTrace | undefined, page: AgentTrace): AgentTrace {
	if (!previous) {
		return page;
	}
	if (previous.sessionId !== page.sessionId) {
		throw new Error(localize('agentTrace.changedSession', 'Trace belongs to another conversation.'));
	}
	const threads = new Map(previous.threads.map(thread => [thread.threadId, thread]));
	for (const thread of page.threads) {
		const existing = threads.get(thread.threadId);
		const after = existing?.events.at(-1)?.sequence ?? 0;
		threads.set(thread.threadId, {
			...thread,
			events: [...(existing?.events ?? []), ...thread.events.filter(record => record.sequence > after)],
		});
	}
	const prefixes = new Map(
		[...previous.historyPrefixes, ...page.historyPrefixes].map(prefix => [JSON.stringify(prefix), prefix]),
	);
	const calls = new Map(
		[...(previous.performance?.calls ?? []), ...(page.performance?.calls ?? [])].map(call => [
			performanceKey(call.threadId, call.eventId),
			call,
		]),
	);
	const performance: AgentTracePerformance | undefined =
		previous.performance || page.performance ? { formatVersion: 1, calls: [...calls.values()] } : undefined;
	return {
		...previous,
		...page,
		...(performance ? { performance } : {}),
		historyPrefixes: [...prefixes.values()],
		...(previous.diagnostics ? { diagnostics: previous.diagnostics } : {}),
		...(previous.graph
			? { graph: page.threads.some(thread => thread.events.length) ? undefined : previous.graph }
			: {}),
		threads: [...threads.values()],
	};
}

/** Checks pagination progress before a reader can advance its durable cursors. */
export function parseAgentTracePage(
	value: unknown,
	cursors: unknown,
	hasMore: unknown,
	sessionId: string,
	after: Readonly<Record<string, number>>,
): AgentTracePage {
	const trace = parseAgentTrace(value);
	if (trace.sessionId !== sessionId) {
		throw new Error(localize('agentTrace.changedSession', 'Trace belongs to another conversation.'));
	}
	const invalid = (): never => {
		throw new Error(localize('agentTrace.invalidPage', 'Invalid trace cursors or pagination progress.'));
	};
	if (!isRecord(cursors) || typeof hasMore !== 'boolean' || Object.keys(cursors).length !== trace.threads.length) {
		return invalid();
	}
	let progressed = false;
	for (const thread of trace.threads) {
		const previous = after[thread.threadId] ?? 0;
		const next = cursors[thread.threadId];
		if (
			typeof next !== 'number' ||
			!Number.isSafeInteger(next) ||
			next < previous ||
			next !== (thread.events.at(-1)?.sequence ?? previous) ||
			thread.events.some(record => record.sequence <= previous)
		) {
			return invalid();
		}
		progressed ||= next > previous;
	}
	if (hasMore && !progressed) {
		return invalid();
	}
	return { trace, cursors: cursors as Readonly<Record<string, number>>, hasMore };
}
