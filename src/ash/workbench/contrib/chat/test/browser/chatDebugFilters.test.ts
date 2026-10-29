import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ChatDebugFilterState } from '../../browser/chatDebug/chatDebugFilters.js';
import type { AgentTraceEvent } from '../../common/chatDebugEvents.js';

function event(type: string, date = '2026-10-18T23:59:59.999Z'): AgentTraceEvent {
	return { eventId: 'event', sequence: 1, recordedAt: Date.parse(date), event: { type, threadId: 'RootID' } };
}

suite('Chat Debug structured filters', () => {
	test('combines kind, exact identities, UTC bounds, include alternatives and exclusions', () => {
		using state = new ChatDebugFilterState();
		state.setTextFilter('Thread:RootID, turn:TurnID, after:2026-10-18, before:2026-10-18, hello, world, !private');
		assert.equal(state.error, undefined);
		assert.equal(state.matches(event('modelAttemptStarted'), 'TurnID', false, 'hello'), true);
		assert.equal(state.matches(event('modelInvocationRecorded'), 'TurnID', false, 'world private'), false);
		assert.equal(state.matches(event('modelInvocationRecorded'), 'turnid', false, 'hello'), false);
		assert.equal(state.matches(event('modelInvocationRecorded', '2026-10-19T00:00:00Z'), 'TurnID', false, 'hello'), false);
		state.setKindVisible('modelTurn', false);
		assert.equal(state.matches(event('modelAttemptStarted'), 'TurnID', false, 'hello'), false);
		state.reset();
		assert.equal(state.active, false);
		assert.equal(state.matches(event('modelAttemptStarted'), 'TurnID', false, 'hello'), true);
	});

	test('rejects impossible, reversed and zone-less time filters without showing unrelated events', () => {
		using state = new ChatDebugFilterState();
		for (const query of ['after:2026-02-30', 'before:2026-10-18T12:00:00', 'after:2026-10-19 before:2026-10-18', 'thread:']) {
			state.setTextFilter(query);
			assert.match(state.error!, /Invalid trace filter/);
			assert.equal(state.matches(event('modelAttemptStarted'), undefined, false, ''), false);
		}
		state.setTextFilter('after:2026-10-19T01:00:00+02:00');
		assert.equal(state.error, undefined);
		assert.equal(state.matches(event('modelAttemptStarted'), undefined, false, ''), true);
	});

	test('keeps failure filtering independent of kind and never hides unknown event kinds by default', () => {
		using state = new ChatDebugFilterState();
		state.setErrorsOnly(true);
		assert.equal(state.matches(event('futureEvent'), undefined, false, ''), false);
		assert.equal(state.matches(event('futureEvent'), undefined, true, ''), true);
		state.setKindVisible('generic', false);
		assert.equal(state.matches(event('futureEvent'), undefined, true, ''), false);
	});
});
