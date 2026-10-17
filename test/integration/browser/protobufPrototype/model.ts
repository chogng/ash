/** Test-only wire model. Field numbers are deterministic within this prototype;
 * this is not a negotiated product protocol or a second domain model.
 * Optional fields and array wrappers preserve missing versus empty/default values.
 */
export const models: Record<string, { fields?: Record<string, string>; array?: string; }> = {
	Envelope: { fields: { jsonrpc: 'string', id: 'JsonValue', method: 'string', params: 'JsonValue', result: 'JsonValue', error: 'JsonValue', threadRead: 'ThreadRead', syntaxQuery: 'SyntaxQuery' } },
	ThreadRead: { fields: { thread: 'Thread', transcript: 'Transcript' } },
	Thread: { fields: { sessionId: 'string', threadId: 'string', agentId: 'string', origin: 'JsonValue', title: 'string', status: 'string', sequence: 'uint64', advisor: 'JsonValue', usage: 'Usage', referenceCost: 'JsonValue', hookRuns: 'JsonValue', turns: 'Turns' } },
	Turns: { array: 'Turn' },
	Turn: { fields: { turnId: 'string', status: 'string', kind: 'string', mode: 'string', toolMode: 'string', approvalMode: 'string', usage: 'Usage', items: 'Items' } },
	Usage: { fields: { modelInvocations: 'uint64', inputTokens: 'Counter', outputTokens: 'Counter', cachedInputTokens: 'Counter', cacheWriteInputTokens: 'Counter', reasoningTokens: 'Counter' } },
	Counter: { fields: { reported: 'uint64', complete: 'bool' } },
	Items: { array: 'Item' },
	Item: { fields: { type: 'string', itemId: 'string', turnId: 'string', text: 'string' } },
	Transcript: { fields: { sessionId: 'string', threadId: 'string', durableSequence: 'uint64', revision: 'uint64', entries: 'Entries' } },
	Entries: { array: 'Entry' },
	Entry: { fields: { type: 'string', entryId: 'string', turnId: 'string', item: 'Item', transient: 'bool' } },
	SyntaxQuery: { fields: { revision: 'uint64', rows: 'JsonValue', facts: 'Facts', brackets: 'JsonValue', parseMs: 'double', queryMs: 'double', incremental: 'bool' } },
	Facts: { fields: { baseRevision: 'JsonValue', edits: 'Edits', symbols: 'JsonValue', folds: 'JsonValue', diagnostics: 'JsonValue' } },
	Edits: { array: 'Coordinates' },
	Coordinates: { array: 'uint32' },
};
