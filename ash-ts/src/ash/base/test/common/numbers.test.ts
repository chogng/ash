import assert from 'node:assert/strict';
import { test } from 'mocha';
import {
	clamp,
	isFiniteNumber,
	isNonNegativeSafeInteger,
	isPositiveSafeInteger,
	isSafeInteger,
	rot,
} from '../../common/numbers.js';

test('clamp preserves values inside the range', () => {
	assert.equal(clamp(4, 1, 8), 4);
});

test('clamp restricts values to either inclusive boundary', () => {
	assert.equal(clamp(-1, 0, 10), 0);
	assert.equal(clamp(12, 0, 10), 10);
});

test('clamp propagates non-numeric inputs', () => {
	assert.equal(Number.isNaN(clamp(Number.NaN, 0, 1)), true);
});

test('rot wraps positive and negative indexes', () => {
	assert.equal(rot(5, 4), 1);
	assert.equal(rot(-1, 4), 3);
	assert.equal(rot(-9, 4), 3);
});

test('isFiniteNumber accepts only finite numbers', () => {
	assert.equal(isFiniteNumber(0), true);
	assert.equal(isFiniteNumber(Number.NaN), false);
	assert.equal(isFiniteNumber(Number.POSITIVE_INFINITY), false);
	assert.equal(isFiniteNumber('1'), false);
});

test('safe integer guards enforce their sign constraints', () => {
	assert.equal(isSafeInteger(-1), true);
	assert.equal(isSafeInteger(1.5), false);
	assert.equal(isSafeInteger(Number.MAX_SAFE_INTEGER + 1), false);
	assert.equal(isNonNegativeSafeInteger(0), true);
	assert.equal(isNonNegativeSafeInteger(-1), false);
	assert.equal(isPositiveSafeInteger(1), true);
	assert.equal(isPositiveSafeInteger(0), false);
});
