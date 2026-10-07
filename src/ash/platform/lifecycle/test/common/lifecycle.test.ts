import assert from 'node:assert/strict';
import { test } from 'mocha';
import { handleVetos } from '../../common/lifecycle.js';

test('shutdown veto collection waits for every check and treats rejected checks as vetoes', async () => {
	const errors: string[] = [];
	let completed = false;
	const isVetoed = await handleVetos([
		true,
		Promise.resolve().then(() => { completed = true; return false; }),
		Promise.reject(new Error('backup failed')),
	], error => errors.push(error.message));
	assert.deepEqual({ isVetoed, completed, errors }, { isVetoed: true, completed: true, errors: ['backup failed'] });
});

test('shutdown veto collection allows shutdown when every check permits it', async () => {
	assert.equal(await handleVetos([false, Promise.resolve(false)], () => { throw new Error('Unexpected veto error'); }), false);
});
