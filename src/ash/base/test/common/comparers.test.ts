import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { compareFileNames, compareFileNamesUnicode } from '../../common/comparers.js';

suite('Filename comparers', () => {
	test('natural order compares the whole filename and resolves equivalent names deterministically', () => {
		const names = ['part10.ts', 'part2.ts', 'part02.ts', 'Part2.ts', '.settings', 'part1.ts'];
		assert.deepEqual(names.sort(compareFileNames), ['.settings', 'part1.ts', 'Part2.ts', 'part02.ts', 'part2.ts', 'part10.ts']);
		assert.ok(compareFileNames('a.z', 'b.a') < 0);
		assert.ok(compareFileNames('resume', 'résumé') < 0);
		assert.equal(compareFileNames('same.ts', 'same.ts'), 0);
	});

	test('null filenames behave as empty names and the legacy argument preserves natural order', () => {
		for (const compare of [compareFileNames, compareFileNamesUnicode]) {
			assert.equal(compare(null, ''), 0);
			assert.equal(compare(null, null), 0);
			assert.ok(compare(null, '.settings') < 0);
			assert.ok(compare('file', null) > 0);
		}
		assert.equal(compareFileNames('part2.ts', 'Part2.ts', true), compareFileNames('part2.ts', 'Part2.ts'));
	});

	test('Unicode order keeps numeric text lexical and case significant', () => {
		const names = ['part2.ts', 'part10.ts', 'Part2.ts', 'part02.ts'];
		assert.deepEqual(names.sort(compareFileNamesUnicode), ['Part2.ts', 'part02.ts', 'part10.ts', 'part2.ts']);
		assert.equal(compareFileNamesUnicode('same.ts', 'same.ts'), 0);
	});
});
