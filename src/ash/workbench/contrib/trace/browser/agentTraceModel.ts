import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { diagnosticPayload, type AgentTrace, type AgentTraceEvent, type AgentTraceDiagnosticEvent, type AgentTraceNode, type AgentTracePayloadRef } from '../../../services/trace/common/agentTrace.js';

export interface SavedTraceRelation {
	readonly kind: string;
	readonly outgoing: boolean;
	readonly target: TraceEntry;
}

export interface TraceEntry {
	readonly id: string;
	readonly kind: 'thread' | 'turn' | 'event';
	readonly threadId: string;
	readonly turnId?: string;
	readonly label: string;
	readonly description?: string;
	readonly key?: string;
	readonly record?: AgentTraceEvent;
	readonly diagnostic?: AgentTraceDiagnosticEvent;
	readonly failed: boolean;
}

/** Derived navigation only; the editor owns raw captures and payloads. Immutable record
 * identities let repeated searches reuse their text without serializing full history. */
export class AgentTraceViewModel {
	readonly entries = new Map<string, TraceEntry>();
	roots: readonly ObjectTreeElement<TraceEntry>[] = [];
	readonly matched = new Set<string>();
	private readonly records = new WeakMap<object, TraceEntry>();
	private readonly entriesByKey = new Map<string, TraceEntry[]>();
	private readonly searchText = new WeakMap<TraceEntry, string>();
	private capture: AgentTrace | undefined;
	private readonly savedRelations = new Map<string, SavedTraceRelation[]>();
	eventCount = 0;
	shownCount = 0;

	update(trace: AgentTrace | undefined): boolean {
		if (trace === this.capture) { return false; }
		this.capture = trace;
		this.entries.clear();
		this.entriesByKey.clear();
		this.eventCount = 0;
		this.savedRelations.clear();
		const threads = new Map<string, { element: TraceEntry; children: ObjectTreeElement<TraceEntry>[]; collapsed: boolean; }>();
		for (const thread of trace?.threads ?? []) {
			const created = thread.events.find(record => record.event.type === 'threadCreated')?.event;
			const entry: TraceEntry = { id: JSON.stringify(['thread', thread.threadId]), kind: 'thread', threadId: thread.threadId, label: typeof created?.title === 'string' ? created.title : localize('agentTrace.threadShort', 'Thread'), description: localize('agentTrace.threadShort', 'Thread'), failed: false };
			threads.set(thread.threadId, { element: entry, children: [], collapsed: false });
		}
		// Diagnostics may refer to a Thread whose durable page is still being read.
		for (const record of trace?.diagnostics?.events ?? []) {
			if (!threads.has(record.threadId)) {
				threads.set(record.threadId, { element: { id: JSON.stringify(['thread', record.threadId]), kind: 'thread', threadId: record.threadId, label: localize('agentTrace.threadShort', 'Thread'), failed: false }, children: [], collapsed: false });
			}
		}
		const lastTurn = new Map<string, { collapsed: boolean; }>();
		const ordinals = new Map<string, number>();
		const turns = new Map<string, { element: TraceEntry; children: ObjectTreeElement<TraceEntry>[]; collapsed: boolean; }>();
		const add = (threadId: string, raw: AgentTraceEvent | AgentTraceDiagnosticEvent, diagnostic: boolean): void => {
			let entry = this.records.get(raw);
			if (!entry) {
				const turnId = diagnostic ? (raw as AgentTraceDiagnosticEvent).turnId ?? undefined : typeof raw.event.turnId === 'string' ? raw.event.turnId : isRecord(raw.event.run) && typeof raw.event.run.turnId === 'string' ? raw.event.run.turnId : isRecord(raw.event.seed) && typeof raw.event.seed.parentTurnId === 'string' ? raw.event.seed.parentTurnId : undefined;
				const record: AgentTraceEvent = diagnostic ? { ...raw, event: { ...raw.event, threadId, turnId } } : raw as AgentTraceEvent;
				entry = { id: JSON.stringify([diagnostic ? 'diagnostic' : 'durable', threadId, raw.sequence]), kind: 'event', threadId, turnId, key: diagnostic ? `diagnostic:${raw.sequence}` : `${threadId}:${raw.sequence}`, record, diagnostic: diagnostic ? raw as AgentTraceDiagnosticEvent : undefined, label: compactEventLabel(record), failed: eventIsError(record) };
				this.records.set(raw, entry);
			}
			this.entries.set(entry.id, entry);
			const keyed = this.entriesByKey.get(entry.key!) ?? [];
			keyed.push(entry);
			this.entriesByKey.set(entry.key!, keyed);
			this.eventCount++;
			const thread = threads.get(threadId)!;
			if (!entry.turnId) { thread.children.push({ element: entry }); return; }
			const id = JSON.stringify(['turn', threadId, entry.turnId]);
			let turn = turns.get(id);
			if (!turn) {
				const ordinal = (ordinals.get(threadId) ?? 0) + 1;
				ordinals.set(threadId, ordinal);
				const previous = lastTurn.get(threadId);
				if (previous) { previous.collapsed = true; }
				turn = { element: { id, kind: 'turn', threadId, turnId: entry.turnId, label: localize('agentTrace.turnOrdinal', 'Turn {0}', ordinal), failed: false }, children: [], collapsed: false };
				lastTurn.set(threadId, turn);
				turns.set(id, turn);
				thread.children.push(turn);
			}
			turn.children.push({ element: entry });
		};
		for (const thread of trace?.threads ?? []) { for (const record of thread.events) { add(thread.threadId, record, false); } }
		for (const record of trace?.diagnostics?.events ?? []) { add(record.threadId, record, true); }
		// An attempt's saved prefix places all its diagnostic phases between durable
		// records. Wall clocks and independent child sequence numbers cannot establish causality.
		const prefixes = new Map<string, number>();
		for (const record of trace?.diagnostics?.events ?? []) {
			if (record.event.type === 'modelAttemptStarted' && Number.isSafeInteger(record.event.sourceThreadSequence) && (record.event.sourceThreadSequence as number) >= 0) { prefixes.set(JSON.stringify([record.threadId, record.turnId, record.event.attemptId]), record.event.sourceThreadSequence as number); }
		}
		const position = (entry: TraceEntry): number => entry.diagnostic ? (prefixes.get(JSON.stringify([entry.threadId, entry.turnId, entry.diagnostic.event.attemptId])) ?? Number.POSITIVE_INFINITY) : entry.record!.sequence;
		for (const turn of turns.values()) {
			turn.children.sort((a, b) => position(a.element) - position(b.element) || Number(!!a.element.diagnostic) - Number(!!b.element.diagnostic) || a.element.record!.sequence - b.element.record!.sequence);
		}
		for (const group of [...threads.values(), ...turns.values()]) { this.entries.set(group.element.id, group.element); }
		const roots = [...threads.values()];
		for (const thread of trace?.threads ?? []) {
			const origin = thread.events.find(record => record.event.type === 'threadCreated')?.event.origin;
			if (!isRecord(origin) || typeof origin.parentThreadId !== 'string' || origin.parentThreadId === thread.threadId) { continue; }
			const parent = threads.get(origin.parentThreadId);
			const child = threads.get(thread.threadId)!;
			// Broken imported ancestry cannot create recursive tree data.
			let cursor: string | undefined = origin.parentThreadId;
			const seen = new Set([thread.threadId]);
			while (cursor && !seen.has(cursor)) {
				seen.add(cursor);
				const ancestor = trace?.threads.find(thread => thread.threadId === cursor)?.events.find(record => record.event.type === 'threadCreated')?.event.origin;
				cursor = isRecord(ancestor) && typeof ancestor.parentThreadId === 'string' ? ancestor.parentThreadId : undefined;
			}
			if (parent && !cursor) { parent.children.push(child); roots.splice(roots.indexOf(child), 1); }
		}
		this.roots = roots;
		this.deriveRelations();
		return true;
	}

	filter(query: string, errorsOnly: boolean): void {
		this.matched.clear();
		this.shownCount = 0;
		for (const entry of this.entries.values()) {
			if (!entry.record || (errorsOnly && !entry.failed)) { continue; }
			let text = this.searchText.get(entry);
			if (query && text === undefined) {
				text = `${entry.threadId} ${entry.turnId ?? ''} ${eventLabel(entry.record)} ${JSON.stringify(entry.record)}`.toLowerCase();
				this.searchText.set(entry, text);
			}
			if (!query || text!.includes(query)) { this.matched.add(entry.id); this.shownCount++; }
		}
	}

	findEvent(threadId: string, turnId?: string, eventId?: string): TraceEntry | undefined {
		return [...this.entries.values()].find(entry => entry.record && entry.threadId === threadId && (!turnId || entry.turnId === turnId) && (!eventId || entry.record.eventId === eventId));
	}

	graphTarget(node: AgentTraceNode): TraceEntry | undefined {
		if (node.eventKey === null) { return this.entries.get(JSON.stringify(['thread', node.threadId])); }
		const candidates = this.entriesByKey.get(node.eventKey)?.filter(entry => entry.threadId === node.threadId && (node.turnId === null || entry.turnId === node.turnId)) ?? [];
		// Graph model attempts use the diagnostic namespace; a durable Thread named
		// "diagnostic" can otherwise share the exact external event key.
		return candidates.find(entry => node.kind === 'modelAttempt' ? !!entry.diagnostic : !entry.diagnostic);
	}

	public relations(entry: TraceEntry): readonly SavedTraceRelation[] { return this.savedRelations.get(entry.id) ?? []; }

	private deriveRelations(): void {
		const records = [...this.entries.values()].filter(entry => entry.record);
		const calls = new Map<string, TraceEntry[]>();
		const results = new Map<string, TraceEntry[]>();
		const produced = new Map<string, TraceEntry[]>();
		const received = new Map<string, TraceEntry[]>();
		const joins = new Map<string, TraceEntry[]>();
		const requests = new Map<string, TraceEntry[]>();
		const invocations = new Map<string, TraceEntry[]>();
		const attempts = new Map<string, TraceEntry[]>();
		const receiptsByInvocation = new Map<string, TraceEntry[]>();
		const receiptsByAttempt = new Map<string, TraceEntry[]>();
		const key = (...parts: unknown[]): string => JSON.stringify(parts);
		const index = (map: Map<string, TraceEntry[]>, identity: string, entry: TraceEntry): void => { const values = map.get(identity) ?? []; values.push(entry); map.set(identity, values); };
		const unique = (values: TraceEntry[] | undefined): TraceEntry | undefined => values?.length === 1 ? values[0] : undefined;
		const link = (source: TraceEntry | undefined, target: TraceEntry | undefined, kind: string): void => {
			if (!source || !target || source === target) { return; }
			for (const [owner, other, outgoing] of [[source, target, true], [target, source, false]] as const) {
				const values = this.savedRelations.get(owner.id) ?? [];
				if (!values.some(value => value.target === other && value.kind === kind && value.outgoing === outgoing)) { values.push({ target: other, kind, outgoing }); this.savedRelations.set(owner.id, values); }
			}
		};
		for (const entry of records) {
			const event = entry.record!.event;
			if (!entry.diagnostic && event.type === 'modelInvocationRecorded' && isRecord(event.record) && typeof event.record.invocationId === 'string') { index(invocations, key(entry.threadId, entry.turnId, event.record.invocationId), entry); }
			if (entry.diagnostic && event.type === 'modelAttemptStarted' && typeof event.attemptId === 'string') { index(attempts, key(entry.threadId, entry.turnId, event.attemptId), entry); }
			if (entry.diagnostic && event.type === 'modelAttemptAccounted') {
				index(receiptsByInvocation, key(entry.threadId, entry.turnId, event.invocationId), entry);
				index(receiptsByAttempt, key(entry.threadId, entry.turnId, event.attemptId), entry);
			}
			const item = isRecord(event.item) ? event.item : undefined;
			if (event.type === 'itemCompleted' && typeof item?.toolCallId === 'string') {
				if (item.type === 'toolCall') { index(calls, key(entry.threadId, entry.turnId, item.toolCallId), entry); }
				if (item.type === 'toolResult') { index(results, key(entry.threadId, entry.turnId, item.toolCallId), entry); }
			}
			if (event.type === 'delegationRequested' && isRecord(event.seed) && typeof event.seed.delegationId === 'string') { index(requests, key(entry.threadId, event.seed.delegationId), entry); }
			if (isRecord(event.result)) {
				const result = event.result;
				if (typeof result.delegationId === 'string' && typeof result.childThreadId === 'string' && typeof result.digest === 'string') {
					const identity = key(result.delegationId, result.childThreadId, result.digest);
					if (event.type === 'delegationResultProduced' && entry.threadId === result.childThreadId) { index(produced, identity, entry); }
					if (event.type === 'delegationResultReceived') { index(received, identity, entry); }
				}
			}
			if (event.type === 'agentJoinRequested' && isRecord(event.join) && typeof event.join.joinId === 'string') { index(joins, key(entry.threadId, event.join.joinId), entry); }
		}
		for (const [identity, entries] of results) { link(unique(calls.get(identity)), unique(entries), 'result'); }
		for (const [identity, entries] of received) {
			const source = unique(produced.get(identity));
			const target = unique(entries);
			const origin = source && this.capture?.threads.find(thread => thread.threadId === source.threadId)?.events.find(record => record.event.type === 'threadCreated')?.event.origin;
			const result = target?.record?.event.result;
			if (isRecord(origin) && origin.type === 'agentSpawn' && origin.parentThreadId === target?.threadId && isRecord(result) && origin.delegationId === result.delegationId) { link(source, target, 'returnsResult'); }
		}
		for (const entry of records) {
			const event = entry.record!.event;
			if (entry.diagnostic && event.type === 'modelAttemptAccounted') {
				const target = unique(invocations.get(key(entry.threadId, entry.turnId, event.invocationId)));
				if (unique(receiptsByInvocation.get(key(entry.threadId, entry.turnId, event.invocationId))) === entry && unique(receiptsByAttempt.get(key(entry.threadId, entry.turnId, event.attemptId))) === entry && target?.record?.sequence === event.sourceThreadSequence) { link(entry, target, 'accountsFor'); link(unique(attempts.get(key(entry.threadId, entry.turnId, event.attemptId))), target, 'accountsFor'); }
			}
			if (event.type === 'delegationStarted' && typeof event.delegationId === 'string' && typeof event.childThreadId === 'string') {
				const child = this.entries.get(key('thread', event.childThreadId));
				const origin = this.capture?.threads.find(thread => thread.threadId === event.childThreadId)?.events.find(record => record.event.type === 'threadCreated')?.event.origin;
				if (isRecord(origin) && origin.type === 'agentSpawn' && origin.parentThreadId === entry.threadId && origin.delegationId === event.delegationId) { link(entry, child, 'delegates'); link(unique(requests.get(key(entry.threadId, event.delegationId))), entry, 'startsDelegation'); }
			}
			if (event.type === 'agentJoinSatisfied' && typeof event.joinId === 'string' && Array.isArray(event.satisfiedBy)) {
				const requested = unique(joins.get(key(entry.threadId, event.joinId)));
				if (requested && isRecord(requested.record?.event.join)) {
					const expected = requested.record.event.join.delegations;
					link(requested, entry, 'satisfiesJoin');
					for (const delegationId of event.satisfiedBy) {
						if (typeof delegationId !== 'string' || !Array.isArray(expected) || !expected.includes(delegationId)) { continue; }
						const candidates = [...received.values()].flat().filter(candidate => candidate.threadId === entry.threadId && isRecord(candidate.record?.event.result) && candidate.record.event.result.delegationId === delegationId);
						link(unique(candidates), entry, 'satisfiesJoin');
					}
				}
			}
			const diagnostic = entry.diagnostic;
			const payload = diagnostic && diagnosticPayload(diagnostic);
			const body = payload && this.capture?.diagnostics?.payloads?.[payload.payloadId];
			if (diagnostic?.event.type === 'modelAttemptStarted' && payload?.kind === 'coreRequest' && isRecord(body) && Array.isArray(body.input) && typeof diagnostic.event.sourceThreadSequence === 'number') {
				for (const input of body.input) {
					if (!isRecord(input) || input.type !== 'toolResult' || typeof input.callId !== 'string') { continue; }
					const result = unique(results.get(key(entry.threadId, entry.turnId, input.callId)));
					if (result && result.record!.sequence <= diagnostic.event.sourceThreadSequence) { link(result, entry, 'modelInput'); }
				}
			}
		}
	}

	payload(entry: TraceEntry, output: boolean): { ref?: AgentTracePayloadRef; record?: AgentTraceDiagnosticEvent; } {
		const run = entry.record?.event.run;
		const runId = isRecord(run) ? run.runId : entry.diagnostic?.event.type === 'hookRunRecorded' ? entry.diagnostic.event.runId : undefined;
		if (typeof runId === 'string') {
			const record = this.capture?.diagnostics?.events.find(record => record.threadId === entry.threadId && (record.turnId ?? undefined) === entry.turnId && record.event.type === 'hookRunRecorded' && record.event.runId === runId);
			return { ref: record && diagnosticPayload(record), record };
		}
		const selected = entry.diagnostic;
		if (!selected) { return {}; }
		const candidates = this.capture?.diagnostics?.events.filter(record => record.threadId === selected.threadId && record.turnId === selected.turnId && record.event.attemptId === selected.event.attemptId) ?? [];
		const own = diagnosticPayload(selected);
		if (own && (output ? ['modelResponse', 'partialOutput'].includes(own.kind) : ['coreRequest', 'materializedRequest'].includes(own.kind))) { return { ref: own, record: selected }; }
		const record = candidates.find(record => {
			const ref = diagnosticPayload(record);
			return ref && (output ? ['modelResponse', 'partialOutput'].includes(ref.kind) : ['coreRequest', 'materializedRequest'].includes(ref.kind));
		});
		return { ref: record && diagnosticPayload(record), record };
	}
}

function compactEventLabel(record: AgentTraceEvent): string {
	const full = eventLabel(record);
	const label = full.slice(full.indexOf(' · ') + 3, full.lastIndexOf(' · ' + new Date(record.recordedAt).toISOString()));
	if (record.event.type.startsWith('modelAttempt') || record.event.type === 'modelRequestPrepared' || (isRecord(record.event.item) && record.event.item.type === 'toolResult')) { return label.split(' · ')[0]; }
	return label;
}

function eventIsError(record: AgentTraceEvent): boolean {
	const event = record.event;
	if (event.type === 'hookRunUpdated' && isRecord(event.run) && isRecord(event.run.status)) { return event.run.status.type === 'denied' || event.run.status.type === 'failed'; }
	return event.type === 'modelAttemptFailed' || event.type === 'modelAttemptAbandoned' || event.type === 'turnFailed' || (event.type === 'modelResponseEvaluated' && isRecord(event.decision) && event.decision.action === 'fail') || (event.type === 'turnInterrupted' && isRecord(event.error)) || (isRecord(event.item) && event.item.isError === true) || (isRecord(event.record) && event.record.outcome === 'failed');
}

export function eventLabel(record: AgentTraceEvent): string {
	const event = record.event;
	const item = isRecord(event.item) ? event.item : undefined;
	const invocation = isRecord(event.record) ? event.record : undefined;
	let detail: string;
	switch (item?.type ?? event.type) {
		case 'hookRunUpdated': {
			const run = isRecord(event.run) ? event.run : undefined;
			const status = isRecord(run?.status) ? run.status.type : undefined;
			detail = localize('agentTrace.hookRun', 'Hook · {0} · {1} · {2} ms', String(run?.event ?? ''), hookStatusLabel(status), String(run?.durationMs ?? 0));
			break;
		}
		case 'hookRunRecorded': detail = localize('agentTrace.hookEvidence', 'Hook execution evidence · {0}', String(event.runId)); break;
		case 'modelAttemptStarted': detail = localize('agentTrace.attemptStarted', 'Model attempt started · {0}', String(event.attemptId)); break;
		case 'modelRequestPrepared': detail = localize('agentTrace.requestPrepared', 'Model request prepared · {0}', String(event.attemptId)); break;
		case 'modelAttemptCompleted': detail = localize('agentTrace.attemptCompleted', 'Model attempt completed · {0}', String(event.attemptId)); break;
		case 'modelAttemptFailed': detail = localize('agentTrace.attemptFailed', 'Model attempt failed · {0}', String(event.error)); break;
		case 'modelAttemptCancelled': detail = localize('agentTrace.attemptCancelled', 'Model attempt cancelled · {0}', String(event.reason)); break;
		case 'modelAttemptAbandoned': detail = localize('agentTrace.attemptAbandoned', 'Model attempt abandoned'); break;
		case 'modelAttemptAccounted': detail = localize('agentTrace.attemptAccounted', 'Model attempt linked to accounting · {0}', String(event.invocationId)); break;
		case 'threadCreated': detail = localize('agentTrace.created', 'Thread created'); break;
		case 'turnAccepted': detail = localize('agentTrace.accepted', 'Turn accepted · instructions and model selection'); break;
		case 'turnStarted': detail = localize('agentTrace.started', 'Turn started'); break;
		case 'turnCompleted': detail = localize('agentTrace.completed', 'Turn completed'); break;
		case 'turnFailed': detail = localize('agentTrace.turnFailed', 'Turn failed'); break;
		case 'turnCancelling': detail = localize('agentTrace.cancelling', 'Cancelling Turn'); break;
		case 'turnInterrupted': detail = localize('agentTrace.interrupted', 'Turn interrupted'); break;
		case 'userMessage': detail = localize('agentTrace.input', 'User input · {0}', String(item?.text ?? '').slice(0, 100)); break;
		case 'agentMessage': detail = localize('agentTrace.phasedOutput', 'Agent output · {0} · {1}', phaseLabel(item?.phase), String(item?.text ?? '').slice(0, 100)); break;
		case 'modelResponseEvaluated': {
			const decision = isRecord(event.decision) ? event.decision : undefined;
			const phases = Array.isArray(decision?.messagePhases) ? decision.messagePhases.map(phaseLabel).join(', ') : phaseLabel(undefined);
			detail = localize('agentTrace.loopDecision', 'Loop · {0} · {1} · stop: {2} · phases: {3}', loopActionLabel(decision?.action), loopReasonLabel(decision?.reason), stopReasonLabel(decision?.stopReason), phases);
			break;
		}
		case 'delegationRequested': detail = localize('agentTrace.delegationRequested', 'Child task requested'); break;
		case 'delegationStarted': detail = localize('agentTrace.delegationStarted', 'Child task started'); break;
		case 'delegationResultProduced': detail = localize('agentTrace.resultProduced', 'Child result produced · {0}', isRecord(event.result) ? String(event.result.status) : ''); break;
		case 'delegationResultReceived': detail = localize('agentTrace.resultReceived', 'Child result received · {0}', isRecord(event.result) ? String(event.result.status) : ''); break;
		case 'agentJoinRequested': detail = localize('agentTrace.joinRequested', 'Waiting for child tasks'); break;
		case 'agentJoinSatisfied': detail = localize('agentTrace.joinSatisfied', 'Child task wait satisfied'); break;
		case 'toolCall': detail = localize('agentTrace.toolCall', 'Tool call · {0}', String(item?.name ?? '')); break;
		case 'toolResult': detail = item?.isError ? localize('agentTrace.toolFailed', 'Tool failed · {0}', String(item?.toolCallId ?? '')) : localize('agentTrace.toolResult', 'Tool result · {0}', String(item?.toolCallId ?? '')); break;
		case 'toolExecutionStarted': detail = localize('agentTrace.toolStarted', 'Tool execution started'); break;
		case 'contextCheckpointCommitted': detail = localize('agentTrace.compacted', 'Context checkpoint committed'); break;
		case 'contextOverflowRecoveryCommitted': detail = localize('agentTrace.recovery', 'Context overflow recovery'); break;
		case 'modelInvocationRecorded': {
			const model = isRecord(invocation?.requestedModel) ? invocation.requestedModel : undefined;
			const usage = isRecord(invocation?.usage) ? invocation.usage : undefined;
			detail = localize('agentTrace.modelCall', 'Model call · {0} · {1}', String(invocation?.resolvedModel ?? model?.model ?? ''), String(invocation?.outcome ?? ''));
			if (typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
				detail += localize('agentTrace.tokens', ' · {0} input / {1} output tokens', usage.inputTokens, usage.outputTokens);
			}
			break;
		}
		default: detail = typeof item?.type === 'string' ? item.type : event.type;
	}
	const duration = invocation && typeof invocation.startedAtUnixMs === 'number' && typeof invocation.completedAtUnixMs === 'number' && invocation.completedAtUnixMs >= invocation.startedAtUnixMs ? ` · ${invocation.completedAtUnixMs - invocation.startedAtUnixMs} ms` : '';
	return `${record.sequence} · ${detail} · ${new Date(record.recordedAt).toISOString()}${duration}`;
}

function phaseLabel(phase: unknown): string {
	switch (phase) {
		case 'commentary': return localize('agentTrace.phaseCommentary', 'Commentary');
		case 'partial_answer': return localize('agentTrace.phasePartialAnswer', 'Partial answer');
		case 'final_answer': return localize('agentTrace.phaseFinalAnswer', 'Final answer');
		case null: case undefined: return localize('agentTrace.phaseUnspecified', 'Unspecified');
		default: return typeof phase === 'string' ? phase : isRecord(phase) && typeof phase.other === 'string' ? phase.other : localize('agentTrace.phaseUnspecified', 'Unspecified');
	}
}

function loopActionLabel(action: unknown): string {
	switch (action) {
		case 'executeTools': return localize('agentTrace.loopExecuteTools', 'Execute tools');
		case 'continue': return localize('agentTrace.loopContinue', 'Continue generation');
		case 'complete': return localize('agentTrace.loopComplete', 'Complete Turn');
		case 'fail': return localize('agentTrace.loopFail', 'Fail Turn');
		case 'superseded': return localize('agentTrace.loopSuperseded', 'Superseded by new input');
		default: return String(action ?? '');
	}
}

function loopReasonLabel(reason: unknown): string {
	switch (reason) {
		case 'toolRequests': return localize('agentTrace.reasonToolRequests', 'Pending tool requests');
		case 'finalAnswer': return localize('agentTrace.reasonFinalAnswer', 'Final answer received');
		case 'compatibleCompletion': return localize('agentTrace.reasonCompatibleCompletion', 'Completed without a known phase');
		case 'nonterminalMessage': return localize('agentTrace.reasonNonterminalMessage', 'Nonterminal message received');
		case 'continuationLimit': return localize('agentTrace.reasonContinuationLimit', 'Continuation limit reached');
		case 'truncatedOutput': return localize('agentTrace.reasonTruncatedOutput', 'Output was truncated');
		case 'invalidToolRequest': return localize('agentTrace.reasonInvalidToolRequest', 'Invalid tool request');
		case 'unknownStopReason': return localize('agentTrace.reasonUnknownStopReason', 'Unknown stop reason');
		case 'refusal': return localize('agentTrace.reasonRefusal', 'Model refused the request');
		case 'newInput': return localize('agentTrace.reasonNewInput', 'New input arrived during generation');
		default: return String(reason ?? '');
	}
}

function stopReasonLabel(reason: unknown): string {
	const type = isRecord(reason) ? reason.type : reason;
	switch (type) {
		case 'completed': return localize('agentTrace.stopCompleted', 'Generation completed');
		case 'toolUse': return localize('agentTrace.stopToolUse', 'Tool use');
		case 'maxOutputTokens': return localize('agentTrace.stopMaxOutputTokens', 'Output token limit');
		case 'refusal': return localize('agentTrace.reasonRefusal', 'Model refused the request');
		case 'other': return isRecord(reason) ? String(reason.detail ?? type) : type;
		default: return String(type ?? '');
	}
}

export function recordingLabel(trace: AgentTrace): string {
	switch (trace.diagnostics?.recordingStatus) {
		case 'recording': return localize('agentTrace.recording', 'Local diagnostic evidence enabled.');
		case 'incomplete': return trace.diagnostics.pendingRecords === undefined ? localize('agentTrace.incomplete', 'Diagnostic evidence incomplete · {0} records omitted.', trace.diagnostics.droppedRecords) : localize('agentTrace.incompletePending', 'Diagnostic evidence incomplete · {0} records omitted · {1} records pending.', trace.diagnostics.droppedRecords, trace.diagnostics.pendingRecords);
		case 'unavailable': return localize('agentTrace.unavailable', 'Diagnostic storage unavailable; execution history remains readable.');
		case 'disabled': case undefined: return localize('agentTrace.disabled', 'Request evidence was not enabled. Enable detailed recording in Execution trace settings, then restart the owning App Server.');
	}
}
export function evidenceLabel(kind: string): string {
	switch (kind) {
		case 'hookExecution': return localize('agentTrace.hookExecution', 'Hook command and bounded process input/output');
		case 'coreRequest': return localize('agentTrace.coreRequest', 'Core semantic request · before attachment materialization');
		case 'materializedRequest': return localize('agentTrace.materializedRequest', 'Model service semantic request · after attachment materialization');
		case 'modelResponse': return localize('agentTrace.response', 'Model service response');
		case 'partialOutput': return localize('agentTrace.partialOutput', 'Partial output received before termination');
		default: return kind;
	}
}

export function hookStatusLabel(status: unknown): string {
	switch (status) {
		case 'running': return localize('agentTrace.hookRunning', 'Running');
		case 'continued': return localize('agentTrace.hookContinued', 'Continued');
		case 'denied': return localize('agentTrace.hookDenied', 'Blocked');
		case 'failed': return localize('agentTrace.hookFailed', 'Failed');
		case 'cancelled': return localize('agentTrace.hookCancelled', 'Cancelled');
		default: return String(status ?? '');
	}
}
export function relationLabel(kind: string): string {
	switch (kind) {
		case 'childThread': return localize('agentTrace.childThread', 'Child Thread');
		case 'owns': return localize('agentTrace.owns', 'Owner');
		case 'executes': return localize('agentTrace.executes', 'Execution');
		case 'nestedTool': return localize('agentTrace.nestedTool', 'Nested tool');
		case 'result': return localize('agentTrace.result', 'Tool result');
		case 'deliversMessage': return localize('agentTrace.deliversMessage', 'Message delivery');
		case 'delegates': return localize('agentTrace.delegates', 'Delegation');
		case 'invokes': return localize('agentTrace.invokes', 'Runtime call');
		case 'modelInput': return localize('agentTrace.modelInput', 'Result present in model input');
		case 'returnsResult': return localize('agentTrace.returnsResult', 'Child result returned');
		case 'startsDelegation': return localize('agentTrace.startsDelegation', 'Delegation started');
		case 'satisfiesJoin': return localize('agentTrace.satisfiesJoin', 'Join satisfied');
		case 'requestsTool': return localize('agentTrace.requestsTool', 'Model requested tool');
		case 'accountsFor': return localize('agentTrace.accountsFor', 'Committed model accounting');
		default: return kind;
	}
}
