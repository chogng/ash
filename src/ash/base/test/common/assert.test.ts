import assert from 'node:assert/strict';
import { test } from 'mocha';
import { assert as invariant, assertFn, assertNever, checkAdjacentItems } from '../../common/assert.js';
import { BugIndicatingError } from '../../common/errors.js';

test('assert narrows successful conditions and reports invariant failures', () => {
	const value: string | undefined = 'value';
	invariant(value, 'value is required');
	assert.equal(value.length, 5);
	assert.throws(() => invariant(false, 'broken'), BugIndicatingError);
	assert.throws(() => assertNever(undefined as never, 'unreachable'), /unreachable/);
	assert.doesNotThrow(() => assertFn(() => true));
});

test('checkAdjacentItems validates every neighboring pair', () => {
	assert.equal(checkAdjacentItems([1, 2, 3], (left, right) => left < right), true);
	assert.equal(checkAdjacentItems([1, 3, 2], (left, right) => left < right), false);
	assert.equal(checkAdjacentItems([], () => false), true);
});
