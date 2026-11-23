import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parseDocsDropdown, readDocsDropdown, writeDocsDropdown } from '../../../../../workbench/contrib/markdown/common/arkdownDropdown.js';

test('dropdown block preserves its label, options and selection in Markdown', () => {
	const value = { label: '状态', options: ['待办', '已完成'], selected: 1 };
	const source = writeDocsDropdown(value);
	assert.ok(source.startsWith('```ash-dropdown\n'));
	assert.deepEqual(readDocsDropdown(source + '\n'), value);
	assert.deepEqual(readDocsDropdown(source.replaceAll('\n', '\r\n')), value);
});

test('dropdown persistence rejects malformed input rather than rendering a partial control', () => {
	for (const value of [null, [], {}, { label: 'Status', options: ['One'], selected: 0 },
		{ label: 'Status', options: ['One', ''], selected: 0 },
		{ label: 'Status', options: ['One', 'Two'], selected: -1 },
		{ label: 'Status', options: ['One', 'Two'], selected: 2 },
		{ label: '', options: ['One', 'Two'], selected: 0 },
		{ label: 'Status', options: Array(21).fill('One'), selected: 0 }]) {
		assert.equal(parseDocsDropdown(value), undefined);
	}
	assert.equal(readDocsDropdown('```ash-dropdown\n{broken}\n```'), undefined);
	assert.equal(readDocsDropdown('```json\n{"label":"Status","options":["One","Two"],"selected":0}\n```'), undefined);
});
