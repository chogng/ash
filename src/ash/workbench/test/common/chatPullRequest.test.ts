import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { computePullRequestIcon, getHighestPriorityPullRequestIcon, type ChatPullRequestState } from '../../common/chatPullRequest.js';

suite('Chat pull request icons', () => {
	const states: readonly [ChatPullRequestState, string, string][] = [
		['open', 'git-pull-request', 'charts.green'],
		['draft', 'git-pull-request-draft', 'descriptionForeground'],
		['closed', 'git-pull-request-closed', 'charts.red'],
		['merged', 'git-pull-request-done', 'charts.purple'],
	];

	for (const [state, id, color] of states) {
		test(`${state} has its own glyph and theme color`, () => {
			assert.deepEqual(computePullRequestIcon(state), { id, color: { id: color } });
		});
	}

	test('conflicts and failing checks take priority over unresolved comments on open PRs', () => {
		for (const status of [{ hasMergeConflicts: true }, { hasFailingChecks: true }, { hasMergeConflicts: true, hasFailingChecks: true, hasUnresolvedComments: true }]) {
			assert.deepEqual(computePullRequestIcon('open', status), { id: 'git-pull-request-error', color: { id: 'charts.orange' } });
		}
		assert.deepEqual(computePullRequestIcon('open', { hasUnresolvedComments: true }), { id: 'git-pull-request-comment', color: { id: 'charts.green' } });
		assert.deepEqual(computePullRequestIcon('open', { hasMergeConflicts: false, hasFailingChecks: false, hasUnresolvedComments: false }), computePullRequestIcon('open'));
	});

	test('draft and terminal states are not replaced by live review problems', () => {
		for (const state of ['draft', 'closed', 'merged'] as const) {
			assert.deepEqual(computePullRequestIcon(state, { hasMergeConflicts: true, hasFailingChecks: true, hasUnresolvedComments: true }), computePullRequestIcon(state));
		}
	});

	test('a caller cannot change the shared icon identity', () => {
		const icon = computePullRequestIcon('open');
		Object.assign(icon, { id: 'changed' });
		Object.assign(icon.color!, { id: 'changed' });
		assert.deepEqual(computePullRequestIcon('open'), { id: 'git-pull-request', color: { id: 'charts.green' } });
	});

	test('multiple PRs prefer errors, then comments, open, draft, merged and closed', () => {
		const icons = [computePullRequestIcon('open', { hasMergeConflicts: true }), computePullRequestIcon('open', { hasUnresolvedComments: true }), computePullRequestIcon('open'), computePullRequestIcon('draft'), computePullRequestIcon('merged'), computePullRequestIcon('closed')];
		for (let index = 0; index < icons.length; index++) {
			assert.equal(getHighestPriorityPullRequestIcon([undefined, ...icons.slice(index).reverse()]), icons[index]);
		}
		assert.equal(getHighestPriorityPullRequestIcon([undefined]), undefined);
		assert.equal(getHighestPriorityPullRequestIcon([icons[0], computePullRequestIcon('open', { hasFailingChecks: true })]), icons[0]);
	});
});
