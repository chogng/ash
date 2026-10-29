import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fingerprintPaths, PreparedInputs } from './preparedInputs.ts';

test('preparation receipts reuse content across processes and repair missing or edited outputs', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-inputs-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, 'source');
	const output = join(root, 'output');
	const receipt = join(root, 'receipt.json');
	await writeFile(source, 'first');
	let calls = 0;
	const prepare = () =>
		new PreparedInputs(receipt).prepare(
			() => fingerprintPaths([source]),
			() => fingerprintPaths([output]),
			async () => {
				calls++;
				await writeFile(output, await readFile(source));
				return true;
			},
		);
	assert.equal(await prepare(), true);
	assert.equal(await prepare(), false);
	assert.equal(calls, 1);
	await writeFile(source, 'second');
	assert.equal(await prepare(), true);
	await rm(output);
	assert.equal(await prepare(), true);
	await writeFile(output, 'damaged');
	assert.equal(await prepare(), true);
	assert.equal(await readFile(output, 'utf8'), 'second');
	await writeFile(receipt, '{broken');
	assert.equal(await prepare(), true);
});

test('concurrent consumers share generation, but edits during generation are not certified', async t => {
	const root = await mkdtemp(join(tmpdir(), 'ash-input-race-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const prepared = new PreparedInputs(join(root, 'receipt.json'));
	let input = 'first';
	let output = '';
	let calls = 0;
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const prepare = () =>
		prepared.prepare(
			async () => input,
			async () => output,
			async () => {
				calls++;
				const snapshot = input;
				started.resolve();
				await finish.promise;
				output = snapshot;
				return true;
			},
		);
	const first = prepare();
	assert.equal(first, prepare());
	await started.promise;
	input = 'second';
	finish.resolve();
	await first;
	await prepare();
	assert.equal(calls, 2);
	assert.equal(output, 'second');
	assert.equal(await prepare(), false);
});
