import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { computeAggregateIssueIcon, computeIssueIcon } from '../../common/chatIssue.js';

suite('Chat Issue icons', () => {
	test('keeps open, completed, discarded and unknown reasons distinct without changing the closed glyph', () => {
		const cases = [
			{ state: 'open', reason: undefined, id: 'issue-opened', color: 'charts.green' },
			{ state: 'open', reason: 'not_planned', id: 'issue-opened', color: 'charts.green' },
			{ state: 'closed', reason: 'completed', id: 'issue-closed', color: 'charts.purple' },
			{ state: 'closed', reason: 'not_planned', id: 'issue-closed', color: 'description.foreground' },
			{ state: 'closed', reason: 'duplicate', id: 'issue-closed', color: 'description.foreground' },
			{ state: 'closed', reason: undefined, id: 'issue-closed', color: 'charts.purple' },
			{ state: 'closed', reason: 'future_reason', id: 'issue-closed', color: 'charts.purple' },
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
			{ id: 'issue-opened', color: { id: 'charts.green' } },
			{ id: 'issue-opened', color: { id: 'charts.green' } },
			{ id: 'issue-opened', color: { id: 'charts.green' } },
			{ id: 'issue-closed', color: { id: 'charts.purple' } },
			{ id: 'issue-closed', color: { id: 'description.foreground' } },
			{ id: 'issue-opened', color: { id: 'charts.green' } },
		]);
	});
});
