import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CursorMove, CursorMoveCommands } from '../../common/cursor/cursorMoveCommands.js';

test('CursorMoveCommands exposes only the standard movement command surface', () => {
	assert.deepEqual(
		Object.getOwnPropertyNames(CursorMoveCommands).filter(name => !['length', 'name', 'prototype'].includes(name)).sort(),
		[
			'addCursorDown', 'addCursorUp', 'cancelSelection', 'expandLineSelection', 'findPositionInViewportIfOutside',
			'line', 'moveTo', 'moveToBeginningOfBuffer', 'moveToBeginningOfLine', 'moveToEndOfBuffer', 'moveToEndOfLine',
			'selectAll', 'simpleMove', 'viewportMove', 'word',
		].sort(),
	);
});

test('CursorMove parses standard directions, units, selection, value, and history flags', () => {
	assert.deepEqual(CursorMove.parse({
		to: CursorMove.RawDirection.Down,
		by: CursorMove.RawUnit.FoldedLine,
		value: 3,
		select: true,
		noHistory: true,
	}), {
		direction: CursorMove.Direction.Down,
		unit: CursorMove.Unit.FoldedLine,
		value: 3,
		select: true,
		noHistory: true,
	});
	assert.deepEqual(CursorMove.parse({ to: CursorMove.RawDirection.Left }), {
		direction: CursorMove.Direction.Left,
		unit: CursorMove.Unit.None,
		value: 1,
		select: false,
		noHistory: false,
	});
	assert.equal(CursorMove.parse({ to: 'diagonal' }), null);
	assert.equal(CursorMove.parse({}), null);
});

test('CursorMove command metadata rejects malformed command arguments', () => {
	const constraint = CursorMove.metadata.args?.[0]?.constraint as ((value: unknown) => boolean);
	assert.equal(constraint({ to: 'left', select: false, value: 2 }), true);
	assert.equal(constraint({ to: 'left', select: 'yes' }), false);
	assert.equal(constraint({ by: 'line' }), false);
});
