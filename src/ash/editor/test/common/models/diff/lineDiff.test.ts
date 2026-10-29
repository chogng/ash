import { DetailedLineRangeMapping } from '../../../../common/diff/rangeMapping.js';
import { LineRange } from '../../../../common/core/ranges/lineRange.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DefaultLinesDiffComputer } from '../../../../common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import { toLineDiff, LineDiffKind, type LineDiff } from '../../../../common/diff/lineDiff.js';

suite('Frontend line diff', () => {
	test('projects a million unchanged lines without expanding their runs', () => {
		const diff = toLineDiff({ changes: [new DetailedLineRangeMapping(new LineRange(500001, 500002), new LineRange(500001, 500003), undefined)], moves: [] }, 1000000, 1000001);
		assert.equal(diff.rows.length, 1000001);
		assert.deepEqual([...diff.rows.unchangedRanges()], [[0, 500000], [500002, 1000001]]);
		assert.deepEqual([...diff.rows.changedEntries()].map(([index, row]) => [index, row.kind]), [[500000, 'modified'], [500001, 'added']]);
		assert.deepEqual([diff.rows.get(499999)?.originalLineIndex, diff.rows.get(500002)?.originalLineIndex, diff.rows.get(1000000)?.modifiedLineIndex], [499999, 500001, 1000000]);
		assert.equal(diff.rows.get(-1), undefined);
		assert.equal(diff.rows.get(1000001), undefined);
		assert.deepEqual([...diff.rows.alignmentEntries()].map(([index]) => index), [499999, 500000, 500001, 1000000]);
	});

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
		assert.deepEqual(Array.from(diff.rows).map(row => [row.kind, row.originalLineIndex, row.modifiedLineIndex]), [
			['unchanged', 0, 0], ['modified', 1, 1], ['removed', 2, undefined], ['unchanged', 3, 2], ['added', undefined, 3],
		]);
		assert.deepEqual(diff.hunks, [
			{ rowStart: 1, rowEnd: 3, originalStartLineIndex: 1, originalLineCount: 2, modifiedStartLineIndex: 1, modifiedLineCount: 1 },
			{ rowStart: 4, rowEnd: 5, originalStartLineIndex: 4, originalLineCount: 0, modifiedStartLineIndex: 3, modifiedLineCount: 1 },
		]);
	});

	test('keeps inserted and deleted configuration blocks whole beside identical opening lines', async () => {
		const added = ['', 'registerConfiguration({', '\tkey: "WorkspaceTrust",', '\tsetting: {', '\t\tvalueType: "boolean",', '\t},', '});'];
		const original = ['imports;', '', 'registerConfiguration({', '\tkey: "SandboxSettings",', '\tsetting: {', '\t\tvalueType: "boolean",', '\t},', '});', 'tail();'];
		const modified = ['imports;', ...added, ...original.slice(1)];
		const computer = new DefaultLinesDiffComputer();
		for (const ignoreTrimWhitespace of [false, true]) {
			for (const reversed of [false, true]) {
				const before = reversed ? modified : original;
				const after = reversed ? original : modified;
				const options = { ignoreTrimWhitespace, maxComputationTimeMs: 0, computeMoves: false };
				const result = computer.computeDiff(before, after, options);
				assert.deepEqual(result.changes.map(change => [
					change.original.startLineNumber, change.original.endLineNumberExclusive,
					change.modified.startLineNumber, change.modified.endLineNumberExclusive,
				]), [[2, reversed ? 9 : 2, 2, reversed ? 2 : 9]]);
				assert.deepEqual(await computer.computeDiffAsync(before, after, options, new AbortController().signal), result);
				const diff = toLineDiff(result, before.length, after.length);
				assert.deepEqual(Array.from(diff.rows).filter(row => row.kind !== LineDiffKind.Unchanged).map(row => reversed
					? before[row.originalLineIndex!] : after[row.modifiedLineIndex!]), added);
			}
		}
	});

	test('keeps separate inserted blocks aligned with their unchanged neighbors', async () => {
		const block = (key: string): string[] => ['', 'register({', `\tkey: "${key}",`, '});'];
		const original = ['head();', ...block('sandbox'), 'separator();', ...block('notifications'), 'tail();'];
		const modified = ['head();', ...block('workspace'), ...block('sandbox'), 'separator();', ...block('banner'), ...block('notifications'), 'tail();'];
		const diff = await compute(original.join('\n'), modified.join('\n'));
		assert.deepEqual(diff.hunks, [
			{ rowStart: 1, rowEnd: 5, originalStartLineIndex: 1, originalLineCount: 0, modifiedStartLineIndex: 1, modifiedLineCount: 4 },
			{ rowStart: 10, rowEnd: 14, originalStartLineIndex: 6, originalLineCount: 0, modifiedStartLineIndex: 10, modifiedLineCount: 4 },
		]);
	});

	test('preserves unchanged context separating a repeated block insertion from replacements', async () => {
		const original = ['oldHead();', '', 'register({', '\tkey: "sandbox",', '});', '', 'oldTail();'];
		const modified = ['newHead();', '', 'register({', '\tkey: "workspace",', '});', '', 'register({', '\tkey: "sandbox",', '});', '', 'newTail();'];
		const diff = await compute(original.join('\n'), modified.join('\n'));
		assert.deepEqual(diff.hunks, [
			{ rowStart: 0, rowEnd: 1, originalStartLineIndex: 0, originalLineCount: 1, modifiedStartLineIndex: 0, modifiedLineCount: 1 },
			{ rowStart: 2, rowEnd: 6, originalStartLineIndex: 2, originalLineCount: 0, modifiedStartLineIndex: 2, modifiedLineCount: 4 },
			{ rowStart: 10, rowEnd: 11, originalStartLineIndex: 6, originalLineCount: 1, modifiedStartLineIndex: 10, modifiedLineCount: 1 },
		]);
	});

	test('does not rotate a block across lines that only match after trimming whitespace', () => {
		const result = new DefaultLinesDiffComputer().computeDiff(['head', '  repeat', 'tail'], ['head', ' repeat', 'added', '  repeat', 'tail'], {
			ignoreTrimWhitespace: true, maxComputationTimeMs: 0, computeMoves: false,
		});
		assert.deepEqual(result.changes.map(change => [
			change.original.startLineNumber, change.original.endLineNumberExclusive,
			change.modified.startLineNumber, change.modified.endLineNumberExclusive,
		]), [[3, 3, 3, 5]]);
	});

	test('pairs an edited declaration with its source line after inserted setup code', async () => {
		const original = ['head', 'const source = new ExplorerDataSource(files, config);', 'tail'];
		const modified = ['head', 'using workspace = new WorkspaceContextService(project);', 'const getValue = config.getValue.bind(config);', 'config.getValue = section => getValue(section);', 'using source = new ExplorerDataSource(config);', 'tail'];
		const computer = new DefaultLinesDiffComputer();
		const options = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false };
		const result = computer.computeDiff(original, modified, options);
		assert.deepEqual(await computer.computeDiffAsync(original, modified, options, new AbortController().signal), result);
		const diff = toLineDiff(result, original.length, modified.length);
		assert.deepEqual(Array.from(diff.rows).map(row => [row.kind, row.originalLineIndex, row.modifiedLineIndex]), [
			['unchanged', 0, 0], ['added', undefined, 1], ['added', undefined, 2], ['added', undefined, 3], ['modified', 1, 4], ['unchanged', 2, 5],
		]);
		assert.equal(diff.hunks.length, 1);
		const declaration = diff.rows.get(4)!;
		assert.deepEqual(declaration.originalChanges.map(range => original[1]!.slice(range.startColumn, range.endColumn)), ['const', 'files, ']);
		assert.deepEqual(declaration.modifiedChanges.map(range => modified[4]!.slice(range.startColumn, range.endColumn)), ['using', '']);
		const reversed = toLineDiff({ changes: result.changes.map(change => change.flip()), moves: [] }, modified.length, original.length);
		assert.deepEqual(Array.from(reversed.rows).map(row => [row.kind, row.originalLineIndex, row.modifiedLineIndex]), [
			['unchanged', 0, 0], ['removed', 1, undefined], ['removed', 2, undefined], ['removed', 3, undefined], ['modified', 4, 1], ['unchanged', 5, 2],
		]);
	});

	test('keeps inserted and removed neighbors separate from multiple edited declarations', async () => {
		const diff = await compute('head\nconst alpha = loadAlpha();\nremovedOnly();\nconst beta = loadBeta();\ntail', 'head\nprepareWorkspace();\nusing alpha = loadAlpha();\nusing beta = loadBeta();\ntail');
		assert.deepEqual(Array.from(diff.rows).map(row => [row.kind, row.originalLineIndex, row.modifiedLineIndex]), [
			['unchanged', 0, 0], ['added', undefined, 1], ['modified', 1, 2], ['removed', 2, undefined], ['modified', 3, 3], ['unchanged', 4, 4],
		]);
		assert.equal(diff.hunks.length, 1);
	});

	test('highlights entire renamed identifiers while keeping unchanged code and punctuation clear', async () => {
		const original = 'const $source_name = new ExplorerDataSource(files);';
		const modified = 'using $result_name = new WorkspaceContextService(files);';
		const diff = await compute(original, modified);
		assert.deepEqual(diff.rows.get(0)!.originalChanges.map(range => original.slice(range.startColumn, range.endColumn)), ['const $source_name', 'ExplorerDataSource']);
		assert.deepEqual(diff.rows.get(0)!.modifiedChanges.map(range => modified.slice(range.startColumn, range.endColumn)), ['using $result_name', 'WorkspaceContextService']);
	});

	test('highlights a rewritten loop continuously instead of keeping incidental punctuation matches', async () => {
		const original = '\t\t\t\tfor (let offset = 0; offset < Math.min(originalCount, modifiedCount); offset++) {';
		const modified = '\t\t\t\tconst pairs = yield* pairChangedLines(original.slice(originalIndex, originalMatch), modified.slice(modifiedIndex, modifiedMatch));';
		const added = '\t\t\t\tfor (const [left, right] of pairs) {';
		const diff = await compute(`${original}\nbody();`, `${modified}\n${added}\nbody();`);
		assert.deepEqual(Array.from(diff.rows).map(row => [row.kind, row.originalLineIndex, row.modifiedLineIndex]), [
			['modified', 0, 0], ['added', undefined, 1], ['unchanged', 1, 2],
		]);
		assert.deepEqual([diff.rows.get(0)!.originalChanges, diff.rows.get(0)!.modifiedChanges], [
			[{ startColumn: 4, endColumn: original.length }],
			[{ startColumn: 4, endColumn: modified.length }],
		]);
	});

	test('groups neighboring argument renames but retains meaningful unchanged expressions between edits', async () => {
		const argumentsDiff = await compute('call(first, second);', 'call(alpha, beta);');
		assert.deepEqual([argumentsDiff.rows.get(0)!.originalChanges, argumentsDiff.rows.get(0)!.modifiedChanges], [
			[{ startColumn: 5, endColumn: 18 }], [{ startColumn: 5, endColumn: 16 }],
		]);
		const separated = await compute('first OLD middle OLD last', 'first NEW middle NEW last');
		assert.deepEqual([separated.rows.get(0)!.originalChanges, separated.rows.get(0)!.modifiedChanges], [
			[{ startColumn: 6, endColumn: 9 }, { startColumn: 17, endColumn: 20 }],
			[{ startColumn: 6, endColumn: 9 }, { startColumn: 17, endColumn: 20 }],
		]);
	});

	test('detects moved code with edits and added lines using document coordinates', () => {
		const block = ['function load(input) {', '  const value = parse(input);', '  return value;', '}'];
		const edited = ['function load(input) {', '  const value = parse(updated);', '  log(value);', '  return value;', '}'];
		const stay = Array.from({ length: 6 }, (_, index) => `stay ${index}`);
		const original = ['head', ...block, ...stay, 'tail'];
		const modified = ['head', ...stay, ...edited, 'tail'];
		const options = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: true };
		const diff = new DefaultLinesDiffComputer().computeDiff(original, modified, options);
		assert.deepEqual(diff.moves.map(move => ({
			original: [move.lineRangeMapping.original.startLineNumber, move.lineRangeMapping.original.endLineNumberExclusive],
			modified: [move.lineRangeMapping.modified.startLineNumber, move.lineRangeMapping.modified.endLineNumberExclusive],
			changes: move.changes.map(change => [change.original.startLineNumber, change.original.endLineNumberExclusive, change.modified.startLineNumber, change.modified.endLineNumberExclusive]),
		})), [{ original: [2, 6], modified: [8, 13], changes: [[3, 4, 9, 11]] }]);
		const inner = diff.moves[0]!.changes[0]!.innerChanges!;
		assert.ok(inner.length > 0 && inner.every(change => change.originalRange.startLineNumber === 3 && change.modifiedRange.startLineNumber === 9));
		const move = diff.moves[0]!;
		const displayed = toLineDiff({ changes: move.changes, moves: [move] }, original.length, modified.length, move.lineRangeMapping);
		assert.deepEqual(Array.from(displayed.rows).map(row => [row.kind, row.originalLineIndex, row.modifiedLineIndex]), [
			['unchanged', 1, 7], ['modified', 2, 8], ['added', undefined, 9], ['unchanged', 3, 10], ['unchanged', 4, 11],
		]);
		assert.deepEqual(new DefaultLinesDiffComputer().computeDiff(original, modified, { ...options, computeMoves: false }).moves, []);
	});

	test('does not infer moves from in-place edits or shared punctuation', () => {
		const computer = new DefaultLinesDiffComputer();
		const options = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: true };
		assert.deepEqual(computer.computeDiff(['const before = 1;', '}'], ['const after = 2;', '}'], options).moves, []);
		assert.deepEqual(computer.computeDiff(['aaa();', '{', '}', 'keep 1', 'keep 2', 'keep 3'], ['keep 1', 'keep 2', 'keep 3', 'bbb();', '{', '}'], options).moves, []);
	});

	test('keeps multiple moved blocks disjoint and honors whitespace comparison', () => {
		const first = ['alpha one', 'alpha two'];
		const second = ['beta one', 'beta two'];
		const middle = Array.from({ length: 8 }, (_, index) => `stable ${index}`);
		const options = { ignoreTrimWhitespace: true, maxComputationTimeMs: 0, computeMoves: true };
		const diff = new DefaultLinesDiffComputer().computeDiff([...first, 'separator', ...second, ...middle], ['separator', ...middle, ...first.map(line => `  ${line}`), 'new separator', ...second], options);
		assert.equal(diff.moves.length, 2);
		assert.deepEqual(diff.moves.map(move => move.changes), [[], []]);
		assert.ok(diff.moves[0]!.lineRangeMapping.original.endLineNumberExclusive <= diff.moves[1]!.lineRangeMapping.original.startLineNumber);
	});

	test('isolates an edited move from new neighboring code on either side', async () => {
		const block = ['function collectRecords(input) {', '  const pendingRecords = prepareRecords(input);', '  auditRecords(pendingRecords);', '  return pendingRecords;', '}'];
		const edited = [...block];
		edited[1] = '  const pendingRecords = prepareRecords(updatedInput);';
		const stay = Array.from({ length: 12 }, (_, index) => `stable record ${index}`);
		const other = ['function other() {', '  return unrelated();', '}'];
		const options = { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: true };
		for (const reverse of [false, true]) {
			const before = ['head', ...block, ...stay, 'tail'];
			const after = ['head', ...stay, ...other, ...edited, 'tail'];
			const original = reverse ? after : before;
			const modified = reverse ? before : after;
			const computer = new DefaultLinesDiffComputer();
			const diff = computer.computeDiff(original, modified, options);
			assert.deepEqual(diff.moves.map(move => ({
				original: [move.lineRangeMapping.original.startLineNumber, move.lineRangeMapping.original.endLineNumberExclusive],
				modified: [move.lineRangeMapping.modified.startLineNumber, move.lineRangeMapping.modified.endLineNumberExclusive],
				changes: move.changes.map(change => [change.original.startLineNumber, change.modified.startLineNumber]),
			})), [{ original: reverse ? [17, 22] : [2, 7], modified: reverse ? [2, 7] : [17, 22], changes: [reverse ? [18, 3] : [3, 18]] }]);
			assert.deepEqual(await computer.computeDiffAsync(original, modified, options, new AbortController().signal), diff);
		}
	});

	test('recognizes repeated identifier renames without unchanged interior lines', () => {
		const block = ['function collectRecords(input) {', '  const pendingRecords = prepareRecords(input);', '  auditRecords(pendingRecords);', '  return pendingRecords;', '}'];
		const edited = block.map(line => line.replaceAll('pendingRecords', 'pendingRecords2').replace('collectRecords(', 'collectRecords2('));
		const stay = Array.from({ length: 12 }, (_, index) => `stable record ${index}`);
		const diff = new DefaultLinesDiffComputer().computeDiff(['head', ...block, ...stay, 'tail'], ['head', ...stay, ...edited, 'tail'], {
			ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: true,
		});
		assert.deepEqual(diff.moves.map(move => ({
			original: [move.lineRangeMapping.original.startLineNumber, move.lineRangeMapping.original.endLineNumberExclusive],
			modified: [move.lineRangeMapping.modified.startLineNumber, move.lineRangeMapping.modified.endLineNumberExclusive],
			changedLines: move.changes[0]!.original.length,
		})), [{ original: [2, 7], modified: [14, 19], changedLines: 4 }]);
	});

	test('does not label a completely rewritten function as a move', () => {
		const block = ['function collectRecords(input) {', '  const pendingRecords = prepareRecords(input);', '  auditRecords(pendingRecords);', '  return pendingRecords;', '}'];
		const rewritten = ['function generateResults(source) {', '  const values = compute(source);', '  print(values);', '  return values;', '}'];
		const stay = Array.from({ length: 12 }, (_, index) => `stable record ${index}`);
		const diff = new DefaultLinesDiffComputer().computeDiff(['head', ...block, ...stay, 'tail'], ['head', ...stay, ...rewritten, 'tail'], {
			ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: true,
		});
		assert.deepEqual(diff.moves, []);
	});

	test('keeps edited moves separate when both hunks contain several blocks', () => {
		const first = ['function first(input) {', '  audit(input);', '  save(input);', '  return input;', '}'];
		const second = ['function second(value) {', '  validate(value);', '  publish(value);', '  return value;', '}'];
		const stay = Array.from({ length: 16 }, (_, index) => `stable row ${index}`);
		const editedFirst = first.map(line => line.replace('audit(input)', 'audit(updated)'));
		const editedSecond = second.map(line => line.replace('validate(value)', 'validate(updated)'));
		const diff = new DefaultLinesDiffComputer().computeDiff(['head', ...first, 'old boundary', ...second, ...stay, 'tail'], ['head', ...stay, ...editedSecond, 'new boundary', ...editedFirst, 'tail'], {
			ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: true,
		});
		assert.deepEqual(diff.moves.map(move => [move.lineRangeMapping.original.startLineNumber, move.lineRangeMapping.original.endLineNumberExclusive, move.lineRangeMapping.modified.startLineNumber, move.lineRangeMapping.modified.endLineNumberExclusive]), [[2, 7, 24, 29], [8, 13, 18, 23]]);
	});

	test('enforces the computation budget with move detection enabled', () => {
		const original = Array.from({ length: 2_000 }, (_, index) => `source ${index}`);
		const diff = new DefaultLinesDiffComputer().computeDiff(original, [...original].reverse(), {
			ignoreTrimWhitespace: false, maxComputationTimeMs: Number.EPSILON, computeMoves: true,
		});
		assert.equal(diff.hitTimeout, true);
		assert.deepEqual(diff.moves, []);
	});

	test('preserves empty documents and trailing empty lines', async () => {
		for (const [original, modified, kinds] of [
			['', '', ['unchanged']],
			['same\n', 'same', ['unchanged', 'removed']],
			['same', 'same\n', ['unchanged', 'added']],
			['', 'text', ['modified']],
			['\n', '', ['unchanged', 'removed']],
		] as const) {
			assert.deepEqual(Array.from((await compute(original, modified)).rows).map(row => row.kind), kinds);
		}
	});

	test('reports separate UTF-16 ranges without splitting emoji or combining graphemes', async () => {
		const diff = await compute('a😀 middle e\u0301 end', 'a🤖 middle o\u0308 end');
		assert.deepEqual([diff.rows.get(0)!.originalChanges, diff.rows.get(0)!.modifiedChanges], [
			[{ startColumn: 1, endColumn: 3 }, { startColumn: 11, endColumn: 13 }],
			[{ startColumn: 1, endColumn: 3 }, { startColumn: 11, endColumn: 13 }],
		]);
		const joined = await compute('x👩‍💻z', 'x👨‍💻z');
		assert.deepEqual(joined.rows.get(0)!.originalChanges, [{ startColumn: 1, endColumn: 6 }]);
	});

	test('groups neighboring identifier edits without matching trailing whitespace to an interior space', async () => {
		const diff = await compute('ab cd', 'aXb cYd ');
		assert.deepEqual([diff.rows.get(0)!.originalChanges, diff.rows.get(0)!.modifiedChanges], [[
			{ startColumn: 0, endColumn: 5 },
		], [
			{ startColumn: 0, endColumn: 8 },
		]]);
	});

	test('retains precise whitespace and punctuation insertions beside unchanged identifiers', async () => {
		for (const [original, modified, expected] of [
			['run(value);', 'run( value );', [[[4, 4], [9, 9]], [[4, 5], [10, 11]]]],
			['run(value);', 'run(value, extra);', [[[9, 9]], [[9, 16]]]],
			['  run(value); ', ' run(value);  ', [[[1, 2], [14, 14]], [[1, 1], [13, 14]]]],
		] as const) {
			const diff = await compute(original, modified);
			assert.deepEqual([diff.rows.get(0)!.originalChanges, diff.rows.get(0)!.modifiedChanges].map(ranges => ranges.map(range => [range.startColumn, range.endColumn])), expected);
		}
	});

	test('finds an optimal alignment with repeated and reordered lines', async () => {
		let seed = 31;
		const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
		const values = ['0', '1', '2', '3', '4', '', '\tkey: "value",', '  return value;', 'register({', '});'];
		for (let attempt = 0; attempt < 600; attempt++) {
			const vocabulary = attempt < 300 ? values.slice(0, 5) : values;
			const original = Array.from({ length: random() % 16 + 1 }, () => vocabulary[random() % vocabulary.length]!);
			const modified = Array.from({ length: random() % 16 + 1 }, () => vocabulary[random() % vocabulary.length]!);
			const diff = await compute(original.join('\n'), modified.join('\n'));
			const unchanged = Array.from(diff.rows).filter(row => row.kind === LineDiffKind.Unchanged);
			assert.equal(unchanged.length, longestCommonSubsequence(original, modified), JSON.stringify({ original, modified }));
			assert.deepEqual(Array.from(diff.rows).flatMap(row => row.originalLineIndex === undefined ? [] : [row.originalLineIndex]), original.map((_, index) => index));
			assert.deepEqual(Array.from(diff.rows).flatMap(row => row.modifiedLineIndex === undefined ? [] : [row.modifiedLineIndex]), modified.map((_, index) => index));
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

	test('completes a large unrelated replacement within the computation budget', () => {
		const original = Array.from({ length: 4_000 }, (_, index) => `before${index}`);
		const modified = original.map((_, index) => `after${index}`);
		const result = new DefaultLinesDiffComputer().computeDiff(original, modified, {
			ignoreTrimWhitespace: false, maxComputationTimeMs: 500, computeMoves: false,
		});
		assert.equal(result.hitTimeout, false);
		assert.equal(result.changes.length, 1);
		assert.equal(result.changes[0]!.innerChanges!.length, original.length);
		assert.deepEqual(result.changes[0]!.innerChanges!.map(change => [change.originalRange.startLineNumber, change.modifiedRange.startLineNumber]), original.map((_, index) => [index + 1, index + 1]));
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
