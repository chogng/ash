import assert from 'node:assert/strict';
import { test } from 'mocha';
import { hasMergeConflictMarkers, parseMergeConflictBlocks } from '../../common/mergeConflict.js';

test('merge conflicts preserve each choice and the exact result range', () => {
	const text = 'before\n<<<<<<< HEAD\ncurrent\n||||||| base\nbase\n=======\nincoming\n>>>>>>> topic\nafter\n';
	const blocks = parseMergeConflictBlocks(text);
	assert.deepEqual(blocks, [{
		start: 'before\n'.length,
		end: text.indexOf('after\n'),
		current: 'current\n',
		base: 'base\n',
		incoming: 'incoming\n',
	}]);
	assert.equal(hasMergeConflictMarkers(text), true);
	assert.equal(hasMergeConflictMarkers(text.slice(0, blocks[0].start) + blocks[0].incoming + text.slice(blocks[0].end)), false);
});

test('merge conflicts parse independent blocks with CRLF line endings', () => {
	const text = '<<<<<<< HEAD\r\na\r\n=======\r\nb\r\n>>>>>>> topic\r\nkeep\r\n<<<<<<< HEAD\r\nc\r\n=======\r\nd\r\n>>>>>>> topic\r\n';
	assert.deepEqual(parseMergeConflictBlocks(text).map(block => [block.current, block.incoming]), [['a\r\n', 'b\r\n'], ['c\r\n', 'd\r\n']]);
});
