import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { AgentTraceViewModel } from '../../browser/agentTraceModel.js';
import type { AgentTrace } from '../../../../services/chat/common/agentTrace.js';

suite('Execution Trace saved execution flow', () => {
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
