import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../../../../editor/common/core/range.js';
import { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';
import { toLineDiff } from '../../../../../editor/common/diff/lineDiff.js';
import { DetailedLineRangeMapping } from '../../../../../editor/common/diff/rangeMapping.js';
import type { LanguageDocumentSymbol } from '../../../../../editor/common/languages.js';
import { compareReviewSymbols } from '../../browser/sessionCodeReviewSymbols.js';

test('review symbols detect additions, removals and moves without counting shifted declarations', () => {
	const symbol = (name: string, line: number, kind: LanguageDocumentSymbol['kind'] = 'function', children?: readonly LanguageDocumentSymbol[]): LanguageDocumentSymbol => ({
		name, kind, range: new Range(line, 1, line, 6), selectionRange: new Range(line, 1, line, 2), children,
	});
	const mapping = (start: number, end: number, modifiedStart: number, modifiedEnd: number) => new DetailedLineRangeMapping(new LineRange(start, end), new LineRange(modifiedStart, modifiedEnd), undefined);
	const diff = toLineDiff({ changes: [mapping(1, 2, 1, 1), mapping(4, 4, 3, 4)], moves: [] }, 5, 5);
	const before = [symbol('moved', 1), symbol('shifted', 2), symbol('deleted', 4), symbol('Tests', 5, 'class', [symbol('oldTest', 5, 'method')])];
	const after = [symbol('shifted', 1), symbol('moved', 3), symbol('created', 4), symbol('Tests', 5, 'class', [symbol('newTest', 5, 'method')])];
	assert.deepEqual(compareReviewSymbols(before, after, diff), [
		{ kind: 'moved', name: 'moved' }, { kind: 'added', name: 'created' }, { kind: 'added', name: 'Tests.newTest' },
		{ kind: 'removed', name: 'deleted' }, { kind: 'removed', name: 'Tests.oldTest' },
	]);
});
