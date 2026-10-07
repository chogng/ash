import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { SearchResultImpl } from '../../../search/browser/searchTreeModel/searchResult.js';
import { parseSearchEditor, searchEditorLocation, serializeSearchResultForEditor } from '../../browser/searchEditorSerialization.js';

test('saved search documents restore multiline queries, filters and exact source ranges across roots', () => {
	const query = { text: 'first\nsecond', patternKind: 'literal' as const, caseSensitivity: 'smart' as const, wholeWord: true, includePatterns: ['src/**'], excludePatterns: ['**/*.test.ts'], maxResults: 100, freshness: 'current' as const };
	const results = new SearchResultImpl([{ id: 'one', index: 0, name: 'one', uri: URI.file('/workspace') }, { id: 'two', index: 1, name: 'two', uri: URI.parse('ssh://server/workspace') }]);
	results.add([
		{ dirId: 'one', path: 'src/main.ts', lineNumber: 4, preview: '中文😀 first\r\nsecond end', ranges: [{ start: 5, end: 18 }] },
		{ dirId: 'two', path: 'src/main.ts', lineNumber: 2, preview: 'first\nsecond', ranges: [{ start: 0, end: 12 }] },
	]);
	const text = serializeSearchResultForEditor(query, results);
	assert.deepEqual(parseSearchEditor(text), query);
	assert.deepEqual(searchEditorLocation(text, 4), { resource: URI.file('/workspace/src/main.ts'), range: new Range(4, 6, 5, 7) });
	assert.deepEqual(searchEditorLocation(text, 7), { resource: URI.parse('ssh://server/workspace/src/main.ts'), range: new Range(2, 1, 3, 7) });
	assert.equal(searchEditorLocation(text, 1), undefined);
	assert.match(text, /first ↵ second/);
});

test('edited search documents reject invalid headers and read edited source positions', () => {
	assert.throws(() => parseSearchEditor('results without a header'), TypeError);
	assert.throws(() => parseSearchEditor('# Search: {"version":1,"query":{"text":4}}'), TypeError);
	const text = '# File: file:///workspace/main.ts\n  8:2-9:4: edited\n  9:4-8:2: invalid';
	assert.deepEqual(searchEditorLocation(text, 2), { resource: URI.file('/workspace/main.ts'), range: new Range(8, 2, 9, 4) });
	assert.equal(searchEditorLocation(text, 3), undefined);
});
