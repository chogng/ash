import type { MethodResult, SessionThreadReadResult } from '../../../../.build/protocol/typescript/index.js';

export function threadWorkload(turns: number, textBytes: number, unicode = false): SessionThreadReadResult {
	const count = { reported: 0, complete: true };
	const usage = { modelInvocations: 0, inputTokens: { ...count }, outputTokens: { ...count }, cachedInputTokens: { ...count }, cacheWriteInputTokens: { ...count }, reasoningTokens: { ...count } };
	const items = Array.from({ length: turns }, (_, index) => ({ type: 'agentMessage' as const, itemId: `answer-${index}`, turnId: `turn-${index}`, text: unicode ? '\ufeff汉🙂e\u0301\0'.repeat(textBytes) : 'x'.repeat(textBytes) }));
	return {
		thread: { sessionId: 'session', threadId: 'thread', agentId: 'agent', origin: { type: 'root' }, title: 'Decode workload', status: 'active', sequence: turns, advisor: { type: 'off' }, usage, referenceCost: { knownAmounts: [], complete: true }, hookRuns: [], turns: items.map(item => ({ turnId: item.turnId, status: 'completed', kind: 'coding', mode: 'agent', toolMode: 'direct', approvalMode: 'manual', usage, items: [item] })) },
		transcript: { sessionId: 'session', threadId: 'thread', durableSequence: turns, revision: turns, entries: items.map(item => ({ type: 'item', entryId: `item:${item.itemId}`, turnId: item.turnId, item, transient: false })) },
	};
}
export function numericWorkload(edits: number): MethodResult<'syntax/query'> {
	return { revision: 2, rows: [], brackets: [], parseMs: 1, queryMs: 1, incremental: true, facts: { baseRevision: 1, edits: Array.from({ length: edits }, (_, index) => [index, 0, index, 4, index, 8]), symbols: { start: 0, deleteCount: 0, items: [] }, folds: { start: 0, deleteCount: 0, items: [] }, diagnostics: { start: 0, deleteCount: 0, items: [] } } };
}
