import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { computeAggregateIssueIcon, computeIssueIcon } from '../../common/chatIssue.js';

suite('Chat Issue icons', () => {
	test('uses the shared issue glyph with open, completed, discarded and unknown reason colors', () => {
		const cases = [
			{ state: 'open', reason: undefined, id: 'issues', color: 'charts.green' },
			{ state: 'open', reason: 'not_planned', id: 'issues', color: 'charts.green' },
			{ state: 'closed', reason: 'completed', id: 'issues', color: 'charts.purple' },
			{ state: 'closed', reason: 'not_planned', id: 'issues', color: 'description.foreground' },
			{ state: 'closed', reason: 'duplicate', id: 'issues', color: 'description.foreground' },
			{ state: 'closed', reason: undefined, id: 'issues', color: 'charts.purple' },
			{ state: 'closed', reason: 'future_reason', id: 'issues', color: 'charts.purple' },
		];
		assert.deepEqual(cases.map(({ state, reason }) => computeIssueIcon(state, reason)), cases.map(({ id, color }) => ({ id, color: { id: color } })));
	});

	test('collections stay active until all states resolve, and distinguish completed from discarded issues', () => {
		const cases = [
			[],
			[undefined, { state: 'closed', stateReason: 'completed' }],
			[{ state: 'open' }, { state: 'closed' }],
			[{ state: 'closed', stateReason: 'not_planned' }, { state: 'closed' }],
			[{ state: 'closed', stateReason: 'not_planned' }, { state: 'closed', stateReason: 'duplicate' }],
			[{ state: 'future' }],
		];
		assert.deepEqual(cases.map(issues => computeAggregateIssueIcon(issues)), [
			{ id: 'issues', color: { id: 'charts.green' } },
			{ id: 'issues', color: { id: 'charts.green' } },
			{ id: 'issues', color: { id: 'charts.green' } },
			{ id: 'issues', color: { id: 'charts.purple' } },
			{ id: 'issues', color: { id: 'description.foreground' } },
			{ id: 'issues', color: { id: 'charts.green' } },
		]);
	});
});
