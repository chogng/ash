import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { AgentTraceViewModel, evidenceLabel, hookStatusLabel, recordingLabel, relationLabel } from '../../browser/agentTraceModel.js';
import type { AgentTrace } from '../../../../services/trace/common/agentTrace.js';

suite('Execution Trace saved execution flow', () => {
	test('links receipts to the exact committed invocation and leaves mismatches unknown', () => {
		const model = new AgentTraceViewModel();
		const ledger = { eventId: 'ledger', sequence: 9, recordedAt: 1, event: { type: 'modelInvocationRecorded', threadId: 'root', turnId: 'turn', record: { invocationId: 'committed' } } };
		const start = { eventId: 'start', sequence: 1, recordedAt: 0, threadId: 'root', turnId: 'turn', event: { type: 'modelAttemptStarted', attemptId: 'attempt', sourceThreadSequence: 8 } };
		const receipt = { eventId: 'receipt', sequence: 2, recordedAt: 0, threadId: 'root', turnId: 'turn', event: { type: 'modelAttemptAccounted', attemptId: 'attempt', invocationId: 'committed', sourceThreadSequence: 9 } };
		const trace: AgentTrace = { formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [{ threadId: 'root', events: [ledger] }], diagnostics: { formatVersion: 2, captureId: 'c', recordingStatus: 'recording', droppedRecords: 0, pendingRecords: 0, events: [start, receipt] } };
		model.update(trace);
		assert.equal(model.relations(model.findEvent('root', 'turn', 'start')!)[0].target.record?.eventId, 'ledger');
		for (const changed of [{ ...receipt, turnId: 'other' }, { ...receipt, event: { ...receipt.event, sourceThreadSequence: 8 } }]) {
			model.update({ ...trace, diagnostics: { ...trace.diagnostics!, events: [start, changed] } });
			assert.deepEqual(model.relations(model.findEvent('root', 'turn', 'start')!), []);
		}
	});

	test('leaves duplicate invocation or attempt receipts unlinked', () => {
		const model = new AgentTraceViewModel();
		const ledger = { eventId: 'ledger', sequence: 9, recordedAt: 1, event: { type: 'modelInvocationRecorded', threadId: 'root', turnId: 'turn', record: { invocationId: 'committed' } } };
		const start = { eventId: 'start', sequence: 1, recordedAt: 0, threadId: 'root', turnId: 'turn', event: { type: 'modelAttemptStarted', attemptId: 'attempt', sourceThreadSequence: 8 } };
		const receipt = { eventId: 'receipt', sequence: 2, recordedAt: 0, threadId: 'root', turnId: 'turn', event: { type: 'modelAttemptAccounted', attemptId: 'attempt', invocationId: 'committed', sourceThreadSequence: 9 } };
		for (const event of [receipt.event, { ...receipt.event, attemptId: 'other' }, { ...receipt.event, invocationId: 'other' }]) {
			model.update({ formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [{ threadId: 'root', events: [ledger] }], diagnostics: { formatVersion: 2, captureId: 'c', recordingStatus: 'recording', droppedRecords: 0, pendingRecords: 0, events: [start, receipt, { ...receipt, eventId: 'duplicate', sequence: 3, event }] } });
			assert.deepEqual(model.relations(model.findEvent('root', 'turn', 'start')!), []);
			assert.deepEqual(model.relations(model.findEvent('root', 'turn', 'receipt')!), []);
		}
	});

	test('reports pending evidence, accounting relations and Hook outcomes using the shipped Chinese catalog', () => {
		const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsMessages(catalog.locale, catalog.bundles);
		try {
			assert.equal(recordingLabel({ formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [], diagnostics: { formatVersion: 2, captureId: 'c', recordingStatus: 'incomplete', droppedRecords: 2, pendingRecords: 3, events: [] } }), '诊断证据不完整 · 已省略 2 条记录 · 3 条记录待写入。');
			assert.equal(relationLabel('accountsFor'), '已提交的模型账目');
			assert.equal(evidenceLabel('hookExecution'), 'Hook 命令与有界的进程输入／输出');
			assert.deepEqual(['running', 'continued', 'denied', 'failed', 'cancelled'].map(hookStatusLabel), ['运行中', '已继续', '已阻止', '失败', '已取消']);
		} finally { resetNlsResolver(); }
	});
	test('associates Hook bodies with the exact Thread, Turn and run, and filters blocked runs as errors', () => {
		const model = new AgentTraceViewModel();
		const ref = { payloadId: 'payload-1', kind: 'hookExecution' as const, byteLength: 1, status: 'saved' as const, digest: 'sha256:' + '0'.repeat(64) };
		const trace: AgentTrace = {
			formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [{ threadId: 'root', events: [{ eventId: 'blocked', sequence: 1, recordedAt: 1, event: { type: 'hookRunUpdated', threadId: 'root', run: { runId: 'run', turnId: 't', hookId: 'hook', event: 'preToolUse', durationMs: 5, status: { type: 'denied', reason: 'blocked' } } } }] }], diagnostics: {
				formatVersion: 1, captureId: 'c', recordingStatus: 'recording', droppedRecords: 0, events: [
					{ eventId: 'wrong-turn', sequence: 1, recordedAt: 1, threadId: 'root', turnId: 'other', event: { type: 'hookRunRecorded', runId: 'run', executionPayload: { ...ref, payloadId: 'payload-2' } } },
					{ eventId: 'wrong-thread', sequence: 2, recordedAt: 1, threadId: 'other', turnId: 't', event: { type: 'hookRunRecorded', runId: 'run', executionPayload: { ...ref, payloadId: 'payload-3' } } },
					{ eventId: 'body', sequence: 3, recordedAt: 1, threadId: 'root', turnId: 't', event: { type: 'hookRunRecorded', runId: 'run', executionPayload: ref } },
				]
			}
		};
		model.update(trace);
		const entry = model.findEvent('root', 't', 'blocked')!;
		assert.equal(model.payload(entry, false).record?.eventId, 'body');
		assert.deepEqual(model.payload(entry, true).ref, ref);
		model.filter('', true);
		assert.deepEqual([...model.matched], [entry.id]);
	});

	test('places model attempts at their saved Thread prefix without using wall-clock order', () => {
		const model = new AgentTraceViewModel();
		const trace: AgentTrace = {
			formatVersion: 3, sessionId: 's', historyPrefixes: [],
			threads: [{
				threadId: 'root', events: [
					{ eventId: 'input', sequence: 1, recordedAt: 999, event: { type: 'turnStarted', threadId: 'root', turnId: 't' } },
					{ eventId: 'call', sequence: 2, recordedAt: 3, event: { type: 'itemCompleted', threadId: 'root', turnId: 't', item: { type: 'toolCall', toolCallId: 'call', name: 'shell-command' } } },
					{ eventId: 'result', sequence: 3, recordedAt: 2, event: { type: 'itemCompleted', threadId: 'root', turnId: 't', item: { type: 'toolResult', toolCallId: 'call', text: 'done' } } },
					{ eventId: 'end', sequence: 4, recordedAt: 1, event: { type: 'turnCompleted', threadId: 'root', turnId: 't' } },
				]
			}],
			diagnostics: {
				formatVersion: 1, captureId: 'c', recordingStatus: 'recording', droppedRecords: 0, events: [
					{ eventId: 'first', sequence: 1, recordedAt: 0, threadId: 'root', turnId: 't', event: { type: 'modelAttemptStarted', attemptId: 'a', sourceThreadSequence: 1 } },
					{ eventId: 'first-end', sequence: 2, recordedAt: 0, threadId: 'root', turnId: 't', event: { type: 'modelAttemptCompleted', attemptId: 'a' } },
					{ eventId: 'next', sequence: 3, recordedAt: 0, threadId: 'root', turnId: 't', event: { type: 'modelAttemptStarted', attemptId: 'b', sourceThreadSequence: 3 } },
				]
			},
		};
		model.update(trace);
		const turn = Array.from(model.roots[0].children!)[0];
		assert.deepEqual(Array.from(turn.children!).map(node => node.element.record?.eventId), ['input', 'first', 'first-end', 'call', 'result', 'next', 'end']);
	});
	test('requires loaded Core input and scopes call IDs to their Thread and Turn', () => {
		const model = new AgentTraceViewModel();
		const event = (threadId: string, sequence: number, item: Record<string, unknown>) => ({ eventId: `${threadId}-${sequence}`, sequence, recordedAt: sequence, event: { type: 'itemCompleted', threadId, turnId: 't', item } });
		const trace: AgentTrace = { formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: ['root', 'other'].map(threadId => ({ threadId, events: [event(threadId, 1, { type: 'toolCall', toolCallId: 'same' }), event(threadId, 2, { type: 'toolResult', toolCallId: 'same' })] })), diagnostics: { formatVersion: 1, captureId: 'c', recordingStatus: 'recording', droppedRecords: 0, events: [{ eventId: 'model', sequence: 1, recordedAt: 3, threadId: 'root', turnId: 't', event: { type: 'modelAttemptStarted', attemptId: 'a', sourceThreadSequence: 2, requestPayload: { payloadId: 'payload-1', kind: 'coreRequest', byteLength: 1, status: 'saved', digest: 'sha256:' + '0'.repeat(64) } } }] } };
		model.update(trace);
		let attempt = model.findEvent('root', 't', 'model')!;
		assert.deepEqual(model.relations(attempt), []);
		model.update({ ...trace, diagnostics: { ...trace.diagnostics!, payloads: { 'payload-1': { input: [{ type: 'toolResult', callId: 'same' }] } } } });
		attempt = model.findEvent('root', 't', 'model')!;
		assert.deepEqual(model.relations(attempt).map(relation => [relation.kind, relation.target.record?.eventId]), [['modelInput', 'root-2']]);
		assert.deepEqual(model.relations(model.findEvent('other', 't', 'other-2')!).map(relation => relation.kind), ['result']);
	});

	test('joins exact child results and refuses a return to another parent or a different digest', () => {
		const model = new AgentTraceViewModel();
		const result = { delegationId: 'd', childThreadId: 'child', digest: 'saved', summary: 'done', status: 'completed' };
		const record = (threadId: string, sequence: number, event: Record<string, unknown>) => ({ eventId: `${threadId}-${sequence}`, sequence, recordedAt: sequence, event: { ...event, type: String(event.type), threadId } });
		const trace: AgentTrace = {
			formatVersion: 3, sessionId: 's', historyPrefixes: [], threads: [
				{ threadId: 'root', events: [record('root', 1, { type: 'delegationResultReceived', result }), record('root', 2, { type: 'agentJoinRequested', join: { joinId: 'j', delegations: ['d'] } }), record('root', 3, { type: 'agentJoinSatisfied', joinId: 'j', satisfiedBy: ['d', 'unknown'] })] },
				{ threadId: 'child', events: [record('child', 1, { type: 'threadCreated', origin: { type: 'agentSpawn', parentThreadId: 'root', delegationId: 'd' } }), record('child', 2, { type: 'delegationResultProduced', result })] },
				{ threadId: 'other', events: [record('other', 1, { type: 'delegationResultReceived', result: { ...result, digest: 'different' } })] },
			]
		};
		model.update(trace);
		assert.deepEqual(model.relations(model.findEvent('root', undefined, 'root-1')!).map(relation => [relation.kind, relation.target.record?.eventId]), [['returnsResult', 'child-2'], ['satisfiesJoin', 'root-3']]);
		assert.deepEqual(model.relations(model.findEvent('other', undefined, 'other-1')!), []);
		model.update({ ...trace, threads: trace.threads.map(thread => thread.threadId === 'other' ? { ...thread, events: [record('other', 1, { type: 'delegationResultReceived', result })] } : thread).filter(thread => thread.threadId !== 'root') });
		assert.deepEqual(model.relations(model.findEvent('other', undefined, 'other-1')!), []);
	});

	test('keeps result consumption unknown for later results, another Turn and ambiguous calls', () => {
		const model = new AgentTraceViewModel();
		const item = (id: string, sequence: number, turnId: string, type: string) => ({ eventId: id, sequence, recordedAt: 1, event: { type: 'itemCompleted', threadId: 'root', turnId, item: { type, toolCallId: 'same' } } });
		const trace: AgentTrace = {
			formatVersion: 3, sessionId: 's', historyPrefixes: [],
			threads: [{ threadId: 'root', events: [item('call-1', 1, 't', 'toolCall'), item('call-2', 2, 't', 'toolCall'), item('result', 4, 't', 'toolResult'), item('other-turn', 5, 'other', 'toolResult')] }],
			diagnostics: { formatVersion: 1, captureId: 'c', recordingStatus: 'recording', droppedRecords: 0, payloads: { 'payload-1': { input: [{ type: 'toolResult', callId: 'same' }] } }, events: [{ eventId: 'model', sequence: 1, recordedAt: 1, threadId: 'root', turnId: 't', event: { type: 'modelAttemptStarted', attemptId: 'a', sourceThreadSequence: 3, requestPayload: { payloadId: 'payload-1', kind: 'coreRequest', byteLength: 1, status: 'saved', digest: 'sha256:' + '0'.repeat(64) } } }] },
		};
		model.update(trace);
		assert.deepEqual(model.relations(model.findEvent('root', 't', 'model')!), []);
		assert.deepEqual(model.relations(model.findEvent('root', 't', 'result')!), []);
		assert.deepEqual(model.relations(model.findEvent('root', 'other', 'other-turn')!), []);
		model.update({ ...trace, threads: [{ threadId: 'root', events: [item('other-turn', 1, 'other', 'toolResult')] }] });
		assert.deepEqual(model.relations(model.findEvent('root', 't', 'model')!), []);
	});

});
