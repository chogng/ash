import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { mergeAgentTrace, mergeAgentTraceDiagnostics, traceOverview, parseAgentTrace, parseAgentTracePage, parseAgentTraceDiagnostics, parseAgentTraceDiagnosticPage, parseAgentTraceGraph } from '../../common/chatDebugEvents.js';

suite('Agent trace artifact', () => {

	test('preserves backend performance across pages and JSON export without a second calculator', () => {
		const event = (id: string, sequence: number) => ({ eventId: id, sequence, recordedAt: 0, event: { type: 'modelInvocationRecorded', threadId: 'root', turnId: 'turn', record: { threadId: 'root', turnId: 'turn', invocationId: id } } });
		const metrics = (id: string) => ({ threadId: 'root', turnId: 'turn', eventId: id, invocationId: id, total: { type: 'measured', microseconds: '18446744073709551615' }, firstText: { type: 'unknown', reason: 'missingTiming' }, generation: { type: 'unknown', reason: 'noTextDeltas' }, textTps: { type: 'unknown', reason: 'singleTextDelta' } });
		const page = (id: string, sequence: number) => ({ formatVersion: 3, sessionId: 's', threads: [{ threadId: 'root', events: [event(id, sequence)] }], historyPrefixes: [], performance: { formatVersion: 1, calls: [metrics(id)] } });
		const first = parseAgentTrace(page('first', 1));
		const second = parseAgentTrace(page('second', 2));
		const merged = mergeAgentTrace(first, second);
		assert.deepEqual(merged.performance?.calls, [metrics('first'), metrics('second')]);
		assert.deepEqual(parseAgentTrace(JSON.parse(JSON.stringify(merged))).performance, merged.performance);
		assert.deepEqual(mergeAgentTrace(merged, parseAgentTrace({ ...page('second', 2), threads: [{ threadId: 'root', events: [] }], performance: { formatVersion: 1, calls: [] } })).performance, merged.performance);
		assert.equal(parseAgentTrace({ ...page('first', 1), performance: undefined }).performance, undefined);
		for (const change of [
			{ invocationId: 'other' }, { eventId: 'other' }, { threadId: 'other' }, { turnId: 'other' },
			{ total: { type: 'measured', microseconds: '18446744073709551616' } },
			{ total: { type: 'measured', microseconds: 2500000 } },
			{ textTps: { type: 'estimated', tokensPerSecond: 'NaN' } },
			{ textTps: { type: 'unknown', reason: 'inventedReason' } },
		]) {
			assert.throws(() => parseAgentTrace({ ...page('first', 1), performance: { formatVersion: 1, calls: [{ ...metrics('first'), ...change }] } }));
		}
		assert.throws(() => parseAgentTrace({ ...page('first', 1), performance: { formatVersion: 1, calls: [metrics('first'), metrics('first')] } }));
	});
	test('validates versioned accounting receipts and pending evidence without changing V3 history', () => {
		const event = { eventId: 'receipt', threadId: 'root', turnId: 'turn', sequence: 1, recordedAt: 1, event: { type: 'modelAttemptAccounted', attemptId: 'attempt', invocationId: 'committed', sourceThreadSequence: 4 } };
		const capture = { formatVersion: 2, captureId: 'capture', recordingStatus: 'incomplete', droppedRecords: 0, pendingRecords: 3, events: [event] };
		assert.equal(parseAgentTraceDiagnostics(capture).pendingRecords, 3);
		assert.throws(() => parseAgentTraceDiagnostics({ ...capture, formatVersion: 1 }));
		assert.throws(() => parseAgentTraceDiagnostics({ ...capture, pendingRecords: undefined }));
		assert.throws(() => parseAgentTraceDiagnostics({ ...capture, pendingRecords: -1 }));
		assert.throws(() => parseAgentTraceDiagnostics({ ...capture, events: [{ ...event, event: { ...event.event, invocationId: '' } }] }));
		assert.throws(() => parseAgentTraceDiagnostics({ ...capture, events: [{ ...event, event: { ...event.event, sourceThreadSequence: 0 } }] }));
		assert.deepEqual(parseAgentTrace({ formatVersion: 3, sessionId: 's', threads: [], historyPrefixes: [], diagnostics: capture }).diagnostics?.events, [event]);
	});
	test('accepts Session Hook evidence without a Turn and rejects incorrect evidence kinds', () => {
		const event = { eventId: 'hook', threadId: 'root', turnId: null, sequence: 1, recordedAt: 1, event: { type: 'hookRunRecorded', runId: 'run', executionPayload: { payloadId: 'payload-1', kind: 'hookExecution', byteLength: 1, status: 'saved', digest: 'sha256:' + '0'.repeat(64) } } };
		const capture = { formatVersion: 1, captureId: 'capture', recordingStatus: 'recording', droppedRecords: 0, events: [event] };
		assert.deepEqual(parseAgentTraceDiagnostics(capture).events, [event]);
		assert.throws(() => parseAgentTraceDiagnostics({ ...capture, events: [{ ...event, event: { ...event.event, runId: '' } }] }));
		assert.throws(() => parseAgentTraceDiagnostics({ ...capture, events: [{ ...event, event: { ...event.event, executionPayload: { ...event.event.executionPayload, kind: 'modelResponse' } } }] }));
		assert.throws(() => parseAgentTraceDiagnostics({ ...capture, events: [{ ...event, event: { type: 'modelAttemptFailed', attemptId: 'a' } }] }));
	});

	test('retains earlier prefix closure when later pages contain no prefix references', () => {
		const trace = parseAgentTrace({ formatVersion: 3, sessionId: 's', threads: [], historyPrefixes: [{ digest: 'retained' }] });
		assert.deepEqual(mergeAgentTrace(trace, { ...trace, historyPrefixes: [] }).historyPrefixes, trace.historyPrefixes);
	});

	test('keeps independent diagnostic order and embedded evidence across incremental reads', () => {
		const event = { eventId: 'e', threadId: 'root', turnId: 'turn', sequence: 1, recordedAt: 1, event: { type: 'modelAttemptFailed', attemptId: 'attempt', error: 'failure', partialOutput: null } };
		const first = parseAgentTraceDiagnostics({ formatVersion: 1, captureId: 'capture', recordingStatus: 'recording', droppedRecords: 0, events: [event] });
		const next = parseAgentTraceDiagnostics({ ...first, recordingStatus: 'incomplete', droppedRecords: 1, events: [{ ...event, eventId: 'other', sequence: 2 }] });
		assert.deepEqual(mergeAgentTraceDiagnostics(first, next).events, [...first.events, ...next.events]);
		assert.equal(parseAgentTraceDiagnosticPage(next, 2, false, 1).cursor, 2);
		assert.throws(() => parseAgentTraceDiagnosticPage(next, 1, false, 1));
		assert.throws(() => parseAgentTraceDiagnosticPage({ ...next, events: [] }, 1, true, 1));
		assert.throws(() => mergeAgentTraceDiagnostics(first, { ...next, captureId: 'replaced' }));
		assert.throws(() => parseAgentTraceDiagnostics({ ...first, payloads: { 'payload-1': { unreferenced: true } } }));
		assert.throws(() => parseAgentTraceDiagnostics({ ...first, events: [{ ...event, event: { type: 'modelAttemptStarted', attemptId: 'attempt', requestPayload: { payloadId: '../secret', byteLength: 1, status: 'saved', kind: 'coreRequest', digest: 'sha256:' + '0'.repeat(64) } } }] }));
		assert.throws(() => parseAgentTraceGraph({ nodes: {}, edges: [{ from: 'missing', to: 'missing', kind: 'owns' }], warnings: [] }));
	});
	test('rejects cross-session, regressing and stalled pagination before advancing cursors', () => {
		const trace = { formatVersion: 3, sessionId: 's', threads: [{ threadId: 'root', events: [{ eventId: 'e', sequence: 2, recordedAt: 1, event: { type: 'turnCompleted', threadId: 'root' } }] }], historyPrefixes: [] };
		assert.deepEqual(parseAgentTracePage(trace, { root: 2 }, false, 's', { root: 1 }).cursors, { root: 2 });
		assert.throws(() => parseAgentTracePage(trace, { root: 2 }, false, 'other', {}));
		assert.throws(() => parseAgentTracePage(trace, { root: 1 }, false, 's', { root: 1 }));
		assert.throws(() => parseAgentTracePage(trace, { root: 2 }, false, 's', { root: 2 }));
		assert.throws(() => parseAgentTracePage({ ...trace, threads: [{ threadId: 'root', events: [] }] }, { root: 1 }, true, 's', { root: 1 }));
		assert.throws(() => parseAgentTracePage(trace, { root: 2, other: 0 }, false, 's', {}));
	});
	test('preserves durable envelopes and prefixes when merging independent Thread cursors', () => {
		const record = (threadId: string, sequence: number): unknown => ({ eventId: `${threadId}-${sequence}`, sequence, recordedAt: 1, schemaVersion: 16, command: { commandId: 'accepted' }, event: { type: 'threadCreated', threadId, unknownFact: true } });
		const first = parseAgentTrace({ formatVersion: 3, sessionId: 's', threads: [{ threadId: 'root', events: [record('root', 1)] }], historyPrefixes: [{ digest: 'original' }], futureField: 'kept' });
		const page = parseAgentTrace({ formatVersion: 3, sessionId: 's', threads: [{ threadId: 'child', events: [record('child', 1)] }, { threadId: 'root', events: [record('root', 1), record('root', 2)] }], historyPrefixes: [{ digest: 'original' }], futureField: 'kept' });
		assert.deepEqual(mergeAgentTrace(first, page), {
			...page,
			threads: [{ threadId: 'root', events: [record('root', 1), record('root', 2)] }, { threadId: 'child', events: [record('child', 1)] }],
		});
		assert.equal(JSON.parse(JSON.stringify(first)).threads[0].events[0].schemaVersion, 16);
		assert.throws(() => mergeAgentTrace(first, { ...page, sessionId: 'another' }));
	});

	test('rejects invalid imports before rendering timestamps or ordering', () => {
		const record = { eventId: 'event', sequence: 1, recordedAt: 1, event: { type: 'threadCreated', threadId: 'root' } };
		const artifact = { formatVersion: 3, sessionId: 's', threads: [{ threadId: 'root', events: [record] }], historyPrefixes: [] };
		for (const value of [
			{ ...artifact, formatVersion: 2 },
			{ ...artifact, threads: [...artifact.threads, ...artifact.threads] },
			{ ...artifact, threads: [{ threadId: 'root', events: [record, record] }] },
			{ ...artifact, threads: [{ threadId: 'other', events: [record] }] },
			{ ...artifact, threads: [{ threadId: 'root', events: [{ ...record, recordedAt: Number.MAX_SAFE_INTEGER }] }] },
		]) { assert.throws(() => parseAgentTrace(value)); }
	});
	test('accepts only covered backend metrics and withholds a summary after capture growth', () => {
		const record = (threadId: string, sequence: number) => ({ eventId: `event-${sequence}`, sequence, recordedAt: sequence, event: { type: 'turnCompleted', threadId, turnId: 'turn' } });
		const metric = { reported: '0', reportedCalls: 1, missingCalls: 0 };
		const trace = parseAgentTrace({
			formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [{ threadId: 'root', events: [record('root', 1)] }], overview: {
				formatVersion: 1, threadCursors: { root: 1 }, eventCount: 1, modelCalls: 1, toolCalls: 0,
				failedModelCalls: 0, cancelledModelCalls: 0, excludedModelCalls: 0,
				inputTokens: metric, outputTokens: metric, cachedInputTokens: { reported: null, reportedCalls: 0, missingCalls: 1 }, totalTokens: metric,
			}
		});
		assert.equal(traceOverview(trace)?.totalTokens.reported, '0');
		const grown = mergeAgentTrace(trace, { ...trace, overview: undefined, threads: [{ threadId: 'root', events: [record('root', 2)] }] });
		assert.equal(traceOverview(grown), undefined);
		assert.throws(() => parseAgentTrace({ ...trace, overview: { ...trace.overview, totalTokens: { ...metric, missingCalls: 1 } } }));
		assert.throws(() => parseAgentTrace({ ...trace, overview: { ...trace.overview, inputTokens: { ...metric, reported: '-1' } } }));
	});

});
