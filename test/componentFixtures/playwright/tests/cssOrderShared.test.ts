import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { bisectConflict, parseFixtureArguments, reverseDocuments, ScanBudgetExceeded } from '../../cssOrderShared.mts';

test('binary search isolates real conflicting files instead of an irrelevant crossing document', async () => {
	let calls = 0;
	const result = await bisectConflict(32, async order => {
		calls++;
		return order.indexOf(3) > order.indexOf(27);
	}, Date.now() + 5000);
	assert.equal(result.kind, 'pair');
	assert.deepEqual(result.indices, [3, 27]);
	assert.equal(result.probes, calls);
	assert.ok(calls < 40, `Unexpected probe count: ${calls}`);
});

test('multi-document behavior yields a confirmed adjacent-pair witness', async () => {
	const result = await bisectConflict(8, async order => order.indexOf(1) > order.indexOf(4) && order.indexOf(4) > order.indexOf(6), Date.now() + 5000);
	assert.equal(result.kind, 'pair');
	assert.ok(result.indices.every(index => [1, 4, 6].includes(index)));
	assert.equal(result.witness!.before.filter((value, index) => value !== result.witness!.after[index]).length, 2);
	const changed = (order: readonly number[]): boolean => order.indexOf(1) > order.indexOf(4) && order.indexOf(4) > order.indexOf(6);
	assert.equal(changed(result.witness!.before), false);
	assert.equal(changed(result.witness!.after), true);
});

test('filtered reversal still identifies a crossed, unselected conflicting document', async () => {
	const result = await bisectConflict(32, async order => order.indexOf(3) > order.indexOf(27), Date.now() + 5000, reverseDocuments(32, [3, 31]));
	assert.equal(result.kind, 'pair');
	assert.deepEqual(result.indices, [3, 27]);
	assert.equal(Math.abs(result.witness!.before.indexOf(3) - result.witness!.before.indexOf(27)), 1);
});

test('unreproducible render and expired budget never become a clean localization', async () => {
	const result = await bisectConflict(4, async () => false, Date.now() + 5000);
	assert.equal(result.kind, 'unlocalized');
	await assert.rejects(bisectConflict(4, async () => true, Date.now() - 1), ScanBudgetExceeded);
});

test('binary search retains a valid boundary when intermediate verdicts are non-monotonic', async () => {
	const oddPermutation = (order: readonly number[]): boolean => {
		let inversions = 0;
		for (let i = 0; i < order.length; i++) {
			for (let j = i + 1; j < order.length; j++) if (order[i] > order[j]) inversions++;
		}
		return inversions % 2 === 1;
	};
	const result = await bisectConflict(3, async order => oddPermutation(order), Date.now() + 5000);
	assert.equal(result.kind, 'pair');
	assert.equal(oddPermutation(result.witness!.before), false);
	assert.equal(oddPermutation(result.witness!.after), true);
});

test('scanner command validates filters, time budget and bounded page concurrency', () => {
	const request = parseFixtureArguments(['--fixture-id-regex', 'Select', '--time-budget-minutes', '2', '--concurrency', '3', '--grep', 'scan registered']);
	assert.deepEqual(request.options, { pattern: 'Select', sourcePattern: '.*', budgetMs: 120_000, concurrency: 3, batchSize: 1000 });
	assert.deepEqual(request.playwrightArgs, ['--grep', 'scan registered']);
	for (const args of [['--batch-size', '0'], ['--batch-size', '2.5'], ['--concurrency', '0'], ['--concurrency', '2.5'], ['--time-budget-minutes', 'Infinity'], ['--fixture-id-regex', '['], ['--stylesheet-source-regex', '']]) {
		assert.throws(() => parseFixtureArguments(args));
	}
});

test('standalone commands show usage and reject missing bisection selection before starting a server', async () => {
	const execute = promisify(execFile);
	const scan = resolve(import.meta.dirname, '../../cssOrderScan.mts');
	const bisect = resolve(import.meta.dirname, '../../cssOrderBisect.mts');
	const help = await execute(process.execPath, [scan, '--help'], { windowsHide: true, timeout: 10_000 });
	assert.match(help.stdout, /Usage:.*cssOrderScan\.mts/);
	assert.doesNotMatch(help.stdout, /Component explorer:/);
	await assert.rejects(execute(process.execPath, [bisect], { windowsHide: true, timeout: 10_000 }), (error: NodeJS.ErrnoException & { stderr?: string; stdout?: string; }) => {
		assert.match(error.stderr ?? '', /Bisection requires --fixture-id-regex/);
		assert.doesNotMatch(error.stdout ?? '', /Component explorer:/);
		return true;
	});
});
