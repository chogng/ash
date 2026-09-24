import assert from 'node:assert/strict';
import { test } from 'mocha';
import { AlternateScrollMode } from '../../browser/instance/alternateScroll.js';

test('Alternate scroll mode blocks wheel-to-arrow conversion only when the child disables it', () => {
	const mode = new AlternateScrollMode();

	assert.equal(mode.shouldProcessWheel('alternate', 'none'), true);
	mode.set([1007], false);
	assert.equal(mode.shouldProcessWheel('alternate', 'none'), false);
	assert.equal(mode.shouldProcessWheel('normal', 'none'), true);
	assert.equal(mode.shouldProcessWheel('alternate', 'vt200'), true);
	mode.set([1007], true);
	assert.equal(mode.shouldProcessWheel('alternate', 'none'), true);
});

test('Alternate scroll mode restores the value saved by the child', () => {
	const mode = new AlternateScrollMode();

	mode.save([1007]);
	mode.set([1007], false);
	mode.restore([1007]);

	assert.equal(mode.shouldProcessWheel('alternate', 'none'), true);
});
