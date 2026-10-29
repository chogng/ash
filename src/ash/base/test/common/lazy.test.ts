import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Lazy } from '../../common/lazy.js';

test('Lazy evaluates once and exposes initialized values', () => {
	let calls = 0;
	const value = new Lazy(() => {
		calls += 1;
		return { calls };
	});

	assert.deepEqual({ hasValue: value.hasValue, rawValue: value.rawValue }, {
		hasValue: false,
		rawValue: undefined,
	});
	assert.equal(value.value, value.value);
	assert.deepEqual({ calls, hasValue: value.hasValue, rawValue: value.rawValue }, {
		calls: 1,
		hasValue: true,
		rawValue: { calls: 1 },
	});
});

test('Lazy retains failures and rejects recursive initialization', () => {
	const failure = new TypeError('broken');
	let calls = 0;
	const broken = new Lazy<never>(() => {
		calls += 1;
		throw failure;
	});

	assert.throws(() => broken.value, error => error === failure);
	assert.throws(() => broken.value, error => error === failure);
	assert.equal(calls, 1);
	const undefinedFailure = new Lazy<never>(() => { throw undefined; });
	assert.throws(() => undefinedFailure.value, error => error === undefined);

	let recursive!: Lazy<number>;
	recursive = new Lazy(() => recursive.value);
	assert.throws(() => recursive.value, /while it is being initialized/);
});
