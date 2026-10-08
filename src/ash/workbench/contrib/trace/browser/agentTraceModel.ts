import { isRecord } from '../../../../base/common/types.js';
import { localize } from '../../../../nls.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { diagnosticPayload, type AgentTrace, type AgentTraceEvent, type AgentTraceDiagnosticEvent, type AgentTraceNode, type AgentTracePayloadRef } from '../../../services/chat/common/agentTrace.js';

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
	eventCount = 0;
	shownCount = 0;

	update(trace: AgentTrace | undefined): boolean {
		if (trace === this.capture) { return false; }
		this.capture = trace;
		this.entries.clear();
		this.entriesByKey.clear();
		this.eventCount = 0;
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
				const turnId = diagnostic ? (raw as AgentTraceDiagnosticEvent).turnId : typeof raw.event.turnId === 'string' ? raw.event.turnId : undefined;
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

	payload(entry: TraceEntry, output: boolean): { ref?: AgentTracePayloadRef; record?: AgentTraceDiagnosticEvent; } {
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
	return event.type === 'modelAttemptFailed' || event.type === 'modelAttemptAbandoned' || event.type === 'turnFailed' || (event.type === 'modelResponseEvaluated' && isRecord(event.decision) && event.decision.action === 'fail') || (event.type === 'turnInterrupted' && isRecord(event.error)) || (isRecord(event.item) && event.item.isError === true) || (isRecord(event.record) && event.record.outcome === 'failed');
}

export function eventLabel(record: AgentTraceEvent): string {
	const event = record.event;
	const item = isRecord(event.item) ? event.item : undefined;
	const invocation = isRecord(event.record) ? event.record : undefined;
	let detail: string;
	switch (item?.type ?? event.type) {
		case 'modelAttemptStarted': detail = localize('agentTrace.attemptStarted', 'Model attempt started · {0}', String(event.attemptId)); break;
		case 'modelRequestPrepared': detail = localize('agentTrace.requestPrepared', 'Model request prepared · {0}', String(event.attemptId)); break;
		case 'modelAttemptCompleted': detail = localize('agentTrace.attemptCompleted', 'Model attempt completed · {0}', String(event.attemptId)); break;
		case 'modelAttemptFailed': detail = localize('agentTrace.attemptFailed', 'Model attempt failed · {0}', String(event.error)); break;
		case 'modelAttemptCancelled': detail = localize('agentTrace.attemptCancelled', 'Model attempt cancelled · {0}', String(event.reason)); break;
		case 'modelAttemptAbandoned': detail = localize('agentTrace.attemptAbandoned', 'Model attempt abandoned'); break;
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
		case 'incomplete': return localize('agentTrace.incomplete', 'Diagnostic evidence incomplete · {0} records omitted.', trace.diagnostics.droppedRecords);
		case 'unavailable': return localize('agentTrace.unavailable', 'Diagnostic storage unavailable; execution history remains readable.');
		case 'disabled': case undefined: return localize('agentTrace.disabled', 'Request evidence was not enabled. Enable detailed recording in Execution trace settings, then restart the owning App Server.');
	}
}
export function evidenceLabel(kind: string): string {
	switch (kind) {
		case 'coreRequest': return localize('agentTrace.coreRequest', 'Core semantic request · before attachment materialization');
		case 'materializedRequest': return localize('agentTrace.materializedRequest', 'Model service semantic request · after attachment materialization');
		case 'modelResponse': return localize('agentTrace.response', 'Model service response');
		case 'partialOutput': return localize('agentTrace.partialOutput', 'Partial output received before termination');
		default: return kind;
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
		case 'requestsTool': return localize('agentTrace.requestsTool', 'Model requested tool');
		default: return kind;
	}
}
