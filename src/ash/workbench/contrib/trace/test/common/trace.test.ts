import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suite, test } from 'mocha';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { URI } from '../../../../../base/common/uri.js';
import { createAgentTraceResource, readAgentTraceLocation, type AgentTraceLocation } from '../../common/trace.js';

suite('Execution Trace location', () => {
	test('preserves the Session-only command and import editor identity', () => {
		assert.equal(createAgentTraceResource().toString(), 'ash-agent-trace:/import');
		assert.equal(readAgentTraceLocation(createAgentTraceResource()), undefined);
		assert.equal(createAgentTraceResource('session').toString(), 'ash-agent-trace:/session');
		assert.deepEqual(readAgentTraceLocation(createAgentTraceResource('session')), { sessionId: 'session' });
	});

	test('restores encoded Thread, Turn and event identities from a saved URI', () => {
		const target = { sessionId: 'session', threadId: 'child / + &= 中文', turnId: 'turn?%', eventId: 'event#=' };
		const resource = createAgentTraceResource(target);
		assert.deepEqual(readAgentTraceLocation(URI.parse(resource.toString())), target);
		assert.notEqual(resource.toString(), createAgentTraceResource({ ...target, turnId: 'another' }).toString());
	});

	for (const target of [null, {}, '', { sessionId: 'session', turnId: 'turn' }, { sessionId: 'session', eventId: 'event' }, { sessionId: 'session', threadId: '' }, { sessionId: 'session', threadId: 1 }, { sessionId: 'session\n' }]) {
		test(`rejects invalid command location ${JSON.stringify(target)}`, () => {
			assert.throws(() => createAgentTraceResource(target as unknown as AgentTraceLocation), /Invalid execution trace location/);
		});
	}

	for (const query of ['turnId=turn', 'eventId=event', 'threadId=one&threadId=two', 'unknown=field', 'threadId=%broken', 'threadId', 'threadId=']) {
		test(`rejects invalid saved location ${query}`, () => {
			assert.throws(() => readAgentTraceLocation(URI.from({ scheme: 'ash-agent-trace', path: '/session', query })), /Invalid execution trace location/);
		});
	}
	test('reports invalid locations in Chinese using the shipped catalog', () => {
		setNlsMessages('zh-CN', JSON.parse(readFileSync('localization/zh-CN/chat.json', 'utf8')));
		try { assert.throws(() => createAgentTraceResource({ sessionId: 's', eventId: 'event' }), /定位 Turn 或事件时必须提供所属 Thread ID/); }
		finally { resetNlsResolver(); }
	});

});
