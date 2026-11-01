import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { parseLinkedText } from '../../common/linkedText.js';

suite('Linked text', () => {
	test('keeps literal text and independent links in order, with either title delimiter', () => {
		const parsed = parseLinkedText('Read [manual](https://example.test "The guide")\nthen [configure](command:settings \'Open "Settings"\').');
		assert.deepEqual(parsed.nodes, ['Read ', { label: 'manual', href: 'https://example.test', title: 'The guide' }, '\nthen ', { label: 'configure', href: 'command:settings', title: 'Open "Settings"' }, '.']);
		assert.equal(parsed.toString(), 'Read manual\nthen configure.');
	});

	test('does not turn malformed or unrelated schemes into actionable content', () => {
		for (const text of ['[empty](command:)', '[empty](https:)', '[bad](random text)', '[script](javascript:alert)', '<b>literal</b>']) {
			assert.deepEqual(parseLinkedText(text).nodes, [text]);
		}
		assert.deepEqual(parseLinkedText('').nodes, []);
	});
});
