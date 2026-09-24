import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DefaultLinesDiffComputer } from '../../../../common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { toLineDiff, LineDiffKind, type LineDiff } from '../../../../common/diff/lineDiff.js';

suite('Frontend line diff', () => {
	test('returns standard line and character mappings with whitespace options', () => {
		const computer = new DefaultLinesDiffComputer();
		const options = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };
		const diff = computer.computeDiff(['same', 'old value', 'tail'], ['same', 'new value', 'tail'], options);
		assert.deepEqual(diff.changes.map(change => ({
			original: [change.original.startLineNumber, change.original.endLineNumberExclusive],
			modified: [change.modified.startLineNumber, change.modified.endLineNumberExclusive],
			inner: change.innerChanges?.map(inner => [
				inner.originalRange.startLineNumber, inner.originalRange.startColumn, inner.originalRange.endColumn,
				inner.modifiedRange.startLineNumber, inner.modifiedRange.startColumn, inner.modifiedRange.endColumn,
			]),
		})), [{ original: [2, 3], modified: [2, 3], inner: [[2, 1, 4, 2, 1, 4]] }]);
		assert.equal(diff.hitTimeout, false);
		assert.deepEqual(computer.computeDiff(['  same  '], ['same'], { ...options, ignoreTrimWhitespace: true }).changes, []);
		const moved = computer.computeDiff(['move', 'stay one', 'stay two'], ['stay one', 'stay two', 'move'], { ...options, computeMoves: true });
		assert.deepEqual(moved.moves.map(move => [
			move.lineRangeMapping.original.startLineNumber,
			move.lineRangeMapping.modified.startLineNumber,
		]), [[1, 3]]);
	});

	test('aligns insertions, removals and replacements into complete hunks', async () => {
		const diff = await compute('same\nold\nremoved\nlast', 'same\nnew\nlast\nadded');
		assert.deepEqual(diff.rows.map(row => [row.kind, row.originalLineIndex, row.modifiedLineIndex]), [
			['unchanged', 0, 0], ['modified', 1, 1], ['removed', 2, undefined], ['unchanged', 3, 2], ['added', undefined, 3],
		]);
		assert.deepEqual(diff.hunks, [
			{ rowStart: 1, rowEnd: 3, originalStartLineIndex: 1, originalLineCount: 2, modifiedStartLineIndex: 1, modifiedLineCount: 1 },
			{ rowStart: 4, rowEnd: 5, originalStartLineIndex: 4, originalLineCount: 0, modifiedStartLineIndex: 3, modifiedLineCount: 1 },
		]);
	});

	test('preserves empty documents and trailing empty lines', async () => {
		for (const [original, modified, kinds] of [
			['', '', ['unchanged']],
			['same\n', 'same', ['unchanged', 'removed']],
			['same', 'same\n', ['unchanged', 'added']],
			['', 'text', ['modified']],
			['\n', '', ['unchanged', 'removed']],
		] as const) {
			assert.deepEqual((await compute(original, modified)).rows.map(row => row.kind), kinds);
		}
	});

	test('reports separate UTF-16 ranges without splitting emoji or combining graphemes', async () => {
		const diff = await compute('a😀 middle e\u0301 end', 'a🤖 middle o\u0308 end');
		assert.deepEqual([diff.rows[0]!.originalChanges, diff.rows[0]!.modifiedChanges], [
			[{ startColumn: 1, endColumn: 3 }, { startColumn: 11, endColumn: 13 }],
			[{ startColumn: 1, endColumn: 3 }, { startColumn: 11, endColumn: 13 }],
		]);
		const joined = await compute('x👩‍💻z', 'x👨‍💻z');
		assert.deepEqual(joined.rows[0]!.originalChanges, [{ startColumn: 1, endColumn: 6 }]);
	});

	test('marks whitespace and inner insertions exactly', async () => {
		const diff = await compute('ab cd', 'aXb cYd ');
		assert.deepEqual([diff.rows[0]!.originalChanges, diff.rows[0]!.modifiedChanges], [[], [
			{ startColumn: 1, endColumn: 2 }, { startColumn: 5, endColumn: 6 }, { startColumn: 7, endColumn: 8 },
		]]);
	});

	test('finds an optimal alignment with repeated and reordered lines', async () => {
		let seed = 31;
		const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
		for (let attempt = 0; attempt < 300; attempt++) {
			const original = Array.from({ length: random() % 16 + 1 }, () => String(random() % 5));
			const modified = Array.from({ length: random() % 16 + 1 }, () => String(random() % 5));
			const diff = await compute(original.join('\n'), modified.join('\n'));
			const unchanged = diff.rows.filter(row => row.kind === LineDiffKind.Unchanged);
			assert.equal(unchanged.length, longestCommonSubsequence(original, modified), JSON.stringify({ original, modified }));
			assert.deepEqual(diff.rows.flatMap(row => row.originalLineIndex === undefined ? [] : [row.originalLineIndex]), original.map((_, index) => index));
			assert.deepEqual(diff.rows.flatMap(row => row.modifiedLineIndex === undefined ? [] : [row.modifiedLineIndex]), modified.map((_, index) => index));
			assert.ok(unchanged.every(row => original[row.originalLineIndex!] === modified[row.modifiedLineIndex!]));
		}
	});

	test('handles large documents with a small live edit', async () => {
		const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index}`);
		const modified = [...lines];
		modified[10_000] = 'unsaved edit';
		const diff = await compute(lines.join('\n'), modified.join('\n'));
		assert.deepEqual(diff.hunks, [{ rowStart: 10_000, rowEnd: 10_001, originalStartLineIndex: 10_000, originalLineCount: 1, modifiedStartLineIndex: 10_000, modifiedLineCount: 1 }]);
	});

	test('stops a running expensive comparison when cancelled', async () => {
		const original = Array.from({ length: 12_000 }, (_, index) => String(index)).join('\n');
		const modified = original.split('\n').reverse().join('\n');
		const controller = new AbortController();
		const result = new DefaultLinesDiffComputer().computeDiffAsync(original.split('\n'), modified.split('\n'), {
			ignoreTrimWhitespace: false,
			maxComputationTimeMs: 0,
			computeMoves: false,
		}, controller.signal);
		controller.abort(new Error('superseded'));
		await assert.rejects(result, /superseded/);
	});
});

async function compute(original: string, modified: string): Promise<LineDiff> {
	const originalLines = original.split('\n');
	const modifiedLines = modified.split('\n');
	const result = await new DefaultLinesDiffComputer().computeDiffAsync(originalLines, modifiedLines, {
		ignoreTrimWhitespace: false,
		maxComputationTimeMs: 0,
		computeMoves: false,
	}, new AbortController().signal);
	return toLineDiff(result, originalLines.length, modifiedLines.length);
}

function longestCommonSubsequence(original: readonly string[], modified: readonly string[]): number {
	const lengths = Array.from({ length: original.length + 1 }, () => new Uint32Array(modified.length + 1));
	for (let left = 1; left <= original.length; left++) {
		for (let right = 1; right <= modified.length; right++) {
			lengths[left]![right] = original[left - 1] === modified[right - 1]
				? lengths[left - 1]![right - 1]! + 1
				: Math.max(lengths[left - 1]![right]!, lengths[left]![right - 1]!);
		}
	}
	return lengths[original.length]![modified.length]!;
}
