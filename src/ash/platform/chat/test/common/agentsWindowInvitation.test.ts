import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { AgentsWindowInvitationState, getAgentHostEditorActivity } from '../../common/agentsWindowInvitation.js';
import { buildOpenSessionLinkUri } from '../../../agentHost/common/openSessionLink.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

const day = 24 * 60 * 60 * 1000;
const resource = (id: string) => buildOpenSessionLinkUri('session', id, 'local');
const history = {
	editorSessionCount: 0,
	lastShown: undefined,
	agentsWindowSessionCount: 0,
	lastAgentsWindowSessionCreated: undefined,
};
function submit(state: AgentsWindowInvitationState, windowId: number, id: string, isNewSession = true): void {
	state.update(windowId, {
		kind: 'request',
		resource: resource(id).toJSON(),
		isNewSession,
		requestSequence: isNewSession ? 1 : 2,
	});
	const previous = state.getState().sessions.filter(session => session.windowId === windowId && session.resource.query !== resource(id).query);
	state.update(windowId, {
		kind: 'sessions',
		sessions: [...previous.map(({ windowId: _owner, ...session }) => session), { resource: resource(id).toJSON(), inProgress: true, needsInput: false }],
	});
}

suite('Agents window invitation activity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('only submitted requests establish ownership, stale catalogs cannot steal it, and Agents follow-ups revoke it', () => {
		using state = new AgentsWindowInvitationState(() => day, history);
		state.update(1, {
			kind: 'sessions',
			sessions: [{ resource: resource('a').toJSON(), inProgress: true, needsInput: false }],
		});
		assert.deepEqual(state.getState().sessions, []);
		submit(state, 1, 'a');
		submit(state, 1, 'a');
		const claim = state.claim(1, resource('a'))!;
		assert.ok(claim);
		submit(state, 2, 'a', false);
		state.update(1, {
			kind: 'sessions',
			sessions: [{ resource: resource('a').toJSON(), inProgress: true, needsInput: false }],
		});
		assert.deepEqual(state.getState().sessions, [{ resource: resource('a').toJSON(), windowId: 2, inProgress: true, needsInput: false }]);
		assert.equal(state.getState().editorSessionCount, 1);
		assert.equal(state.getState().invitation, undefined);
		assert.equal(state.claim(1, resource('a')), undefined);
		state.update(undefined, {
			kind: 'request',
			resource: resource('a').toJSON(),
			isNewSession: false,
			requestSequence: 2,
		});
		state.update(2, {
			kind: 'sessions',
			sessions: [{ resource: resource('a').toJSON(), inProgress: true, needsInput: false }],
		});
		assert.deepEqual(state.getState().sessions, []);
		assert.equal(state.getState().editorSessionCount, 1);
		assert.equal(state.getState().agentsWindowSessionCount, 0);
	});

	test('late accepted replies from an older Thread revision cannot undo a cross-window or Agents handoff', () => {
		using state = new AgentsWindowInvitationState(() => day, history);
		submit(state, 1, 'a');
		submit(state, 2, 'a', false);
		state.update(1, { kind: 'request', resource: resource('a').toJSON(), isNewSession: true, requestSequence: 1 });
		assert.equal(state.getState().sessions[0]?.windowId, 2);
		assert.equal(state.getState().editorSessionCount, 1);
		state.update(undefined, {
			kind: 'request',
			resource: resource('a').toJSON(),
			isNewSession: false,
			requestSequence: 3,
		});
		state.update(2, { kind: 'request', resource: resource('a').toJSON(), isNewSession: false, requestSequence: 2 });
		assert.deepEqual(state.getState().sessions, []);
	});

	test('one global claim survives completion, wrong-window release and duplicate impressions', () => {
		let now = day;
		using state = new AgentsWindowInvitationState(() => now, history);
		submit(state, 1, 'a');
		submit(state, 2, 'b');
		const first = state.claim(1, resource('a'))!;
		assert.equal(state.claim(2, resource('b')), undefined);
		assert.equal(state.getState().lastShown, undefined);
		state.release(2, first.id);
		state.markShown(2, first.id);
		assert.equal(state.getState().lastShown, undefined);
		now++;
		state.markShown(1, first.id);
		const impression = { timestamp: now, editorSessionCount: 2 };
		now++;
		state.markShown(1, first.id);
		state.update(1, {
			kind: 'sessions',
			sessions: [{ resource: resource('a').toJSON(), inProgress: false, needsInput: false }],
		});
		assert.deepEqual(state.getState().lastShown, impression);
		assert.equal(state.getState().invitation?.id, first.id);
		state.resetWindow(1);
		assert.equal(state.getState().invitation, undefined);
		assert.deepEqual(
			state.getState().sessions.map(session => session.windowId),
			[2],
		);
	});

	test('activity excludes waiting sessions and separates the submitting window from other windows', () => {
		using state = new AgentsWindowInvitationState(() => day, history);
		submit(state, 1, 'a');
		submit(state, 1, 'b');
		submit(state, 2, 'c');
		assert.deepEqual(getAgentHostEditorActivity(state.getState(), 1, resource('a')), {
			sameWindow: 2,
			acrossWindows: true,
		});
		state.update(2, {
			kind: 'sessions',
			sessions: [{ resource: resource('c').toJSON(), inProgress: true, needsInput: true }],
		});
		assert.deepEqual(getAgentHostEditorActivity(state.getState(), 1, resource('a')), {
			sameWindow: 2,
			acrossWindows: false,
		});
		assert.equal(state.claim(2, resource('c')), undefined);
		state.update(1, { kind: 'delete', resources: [resource('a').toJSON()] });
		assert.equal(getAgentHostEditorActivity(state.getState(), 1, resource('a')), undefined);
	});

	for (const [additional, elapsed, allowed] of [
		[4, day, false],
		[5, day - 1, false],
		[5, day, true],
	] as const) {
		test(`persisted history requires five additional sessions and one day (${additional}, ${elapsed})`, () => {
			let now = day;
			using before = new AgentsWindowInvitationState(() => now, history);
			submit(before, 1, 'first');
			const claim = before.claim(1, resource('first'))!;
			before.markShown(1, claim.id);
			using after = new AgentsWindowInvitationState(() => now, before.getState());
			for (let index = 0; index < additional; index++) submit(after, (index % 2) + 1, `new-${index}`);
			now += elapsed;
			assert.equal(!!after.claim(((additional - 1) % 2) + 1, resource(`new-${additional - 1}`)), allowed);
		});
	}
	for (const [count, lastCreated, allowed] of [
		[2, undefined, true],
		[3, undefined, false],
		[3, day, false],
		[3, 0, true],
		[3, day + 1, false],
	] as const) {
		test(`active Agents users and legacy creation dates are suppressed (${count}, ${lastCreated})`, () => {
			using state = new AgentsWindowInvitationState(() => 30 * day, {
				...history,
				agentsWindowSessionCount: count,
				lastAgentsWindowSessionCreated: lastCreated,
			});
			submit(state, 1, 'a');
			assert.equal(!!state.claim(1, resource('a')), allowed);
		});
	}
	test('Agents-created sessions update their own usage once and never inflate editor usage', () => {
		using state = new AgentsWindowInvitationState(() => day, history);
		for (let attempt = 0; attempt < 2; attempt++)
			state.update(undefined, {
				kind: 'request',
				resource: resource('a').toJSON(),
				isNewSession: true,
				requestSequence: 1,
			});
		assert.equal(state.getState().editorSessionCount, 0);
		assert.equal(state.getState().agentsWindowSessionCount, 1);
		assert.equal(state.getState().lastAgentsWindowSessionCreated, day);
	});
});
