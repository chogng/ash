import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../../../common/core/range.js';
import { FindOptionOverride, FindReplaceState } from '../../browser/findState.js';

test('find state announces effective option changes and clamps match navigation', () => {
	using state = new FindReplaceState();
	const changes: Array<{ regex: boolean; position: boolean; count: boolean }> = [];
	using listener = state.onFindReplaceStateChange(event => {
		changes.push({ regex: event.isRegex, position: event.matchesPosition, count: event.matchesCount });
	});

	state.change({ isRegex: true, loop: false }, false);
	state.changeMatchInfo(4, 3, new Range(1, 1, 1, 2));
	assert.deepEqual({
		actual: state.actualIsRegex,
		effective: state.isRegex,
		position: state.matchesPosition,
		count: state.matchesCount,
		canGoBack: state.canNavigateBack(),
		canGoForward: state.canNavigateForward(),
	}, { actual: true, effective: true, position: 3, count: 3, canGoBack: true, canGoForward: false });

	state.change({ isRegexOverride: FindOptionOverride.False }, false);
	assert.equal(state.isRegex, false);
	state.change({}, false);
	assert.equal(state.isRegex, true);
	assert.deepEqual(changes, [
		{ regex: true, position: false, count: false },
		{ regex: false, position: true, count: true },
		{ regex: true, position: false, count: false },
		{ regex: true, position: false, count: false },
	]);
});
