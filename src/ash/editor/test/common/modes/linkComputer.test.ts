import assert from 'node:assert/strict';
import { test } from 'mocha';
import { computeLinks } from '../../../common/languages/linkComputer.js';
import { Range } from '../../../common/core/range.js';
import { TextModel } from '../../../common/model/textModel.js';

test('link detection preserves URL punctuation and excludes surrounding prose', () => {
	using model = new TextModel('😀 (https://example.test/a_(b)).\nfile:///tmp/demo.txt; https://[::1]:8080/a?q=1&b=2\n“https://example.test/你好” javascript:alert(1) https://');
	const links = computeLinks(model);
	assert.deepEqual(links.map(link => [link.url, model.getValueInRange(link.range)]), [
		['https://example.test/a_(b)', 'https://example.test/a_(b)'],
		['file:///tmp/demo.txt', 'file:///tmp/demo.txt'],
		['https://[::1]:8080/a?q=1&b=2', 'https://[::1]:8080/a?q=1&b=2'],
		['https://example.test/你好', 'https://example.test/你好'],
	]);
	assert.deepEqual(links[0]!.range, new Range(1, 5, 1, 31));
	assert.deepEqual(computeLinks(null), []);
});
