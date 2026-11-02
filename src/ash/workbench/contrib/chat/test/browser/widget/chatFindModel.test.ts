import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { ChatFindModel, MAX_FIND_MATCHES, type IChatFindOptions } from '../../../browser/widget/chatFind/chatFindModel.js';

const defaults: IChatFindOptions = { isRegex: false, matchCase: false, wholeWord: false };
const item = (id: string, type: IChatListItem['type'], text: string): IChatListItem => ({ id, type, text, transient: false });

suite('ChatFindModel', () => {
	test('searches message text, visible Markdown labels, complete code and voice without indexing evidence or destinations', () => {
		const items = [
			item('request', 'userMessage', 'Needle question'),
			item('reply', 'agentMessage', '**Needle** and [visible](https://needle.invalid)\n\n```ts\nconst needle = 42;\n```'),
			item('reasoning', 'reasoning', 'needle private'), item('tool', 'toolCall', 'needle tool'),
			item('voice', 'voiceTranscript', 'spoken needle'),
		];
		using model = new ChatFindModel(() => items);
		model.setQuery('needle', defaults);
		assert.deepEqual(model.matches.map(match => [match.itemId, match.codeBlockIndex, match.text]), [
			['request', undefined, 'Needle'], ['reply', undefined, 'Needle'], ['reply', 0, 'needle'], ['voice', undefined, 'needle'],
		]);
		model.setQuery('needle.invalid', defaults);
		assert.deepEqual(model.matches, []);
	});

	test('does not search Markdown syntax and keeps inline labels readable', () => {
		using model = new ChatFindModel(() => [item('reply', 'agentMessage', '**bold** hello [world](https://hidden.invalid)\n\n- nested **label**')]);
		model.setQuery('hello world', defaults);
		assert.equal(model.matches.length, 1);
		model.setQuery('nested label', defaults);
		assert.equal(model.matches.length, 1);
		model.setQuery('**', defaults);
		assert.equal(model.matches.length, 0);
	});

	test('supports case, Unicode word boundaries, regex, and literal metacharacters', () => {
		using model = new ChatFindModel(() => [item('request', 'userMessage', 'cat CAT scatter cat_ a.b 中文测试')]);
		model.setQuery('cat', { ...defaults, matchCase: true, wholeWord: true });
		assert.deepEqual(model.matches.map(match => match.text), ['cat']);
		model.setQuery('cat', { ...defaults, wholeWord: true });
		assert.deepEqual(model.matches.map(match => match.text), ['cat', 'CAT']);
		model.setQuery('a.b', defaults);
		assert.deepEqual(model.matches.map(match => match.text), ['a.b']);
		model.setQuery('c[a-z]+', { ...defaults, isRegex: true, matchCase: true });
		assert.deepEqual(model.matches.map(match => match.text), ['cat', 'catter', 'cat']);
		model.setQuery('中文', defaults);
		assert.equal(model.matches.length, 1);
	});

	test('invalid and zero-width expressions do not throw or loop', () => {
		using model = new ChatFindModel(() => [item('request', 'userMessage', '😀 a')]);
		model.setQuery('[', { ...defaults, isRegex: true });
		assert.equal(model.isInvalidRegex, true);
		assert.equal(model.matches.length, 0);
		model.setQuery('(?:)', { ...defaults, isRegex: true });
		assert.equal(model.isInvalidRegex, false);
		assert.equal(model.matches.length, 0);
		model.setQuery('a', defaults);
		assert.equal(model.matches.length, 1);
	});

	test('navigation wraps and starts at the current reading row', () => {
		using model = new ChatFindModel(() => [item('old', 'userMessage', 'term'), item('reading', 'agentMessage', 'term term')], () => 'reading');
		model.setQuery('term', defaults);
		assert.equal(model.activeIndex, 1);
		assert.equal(model.next()?.start, 5);
		assert.equal(model.next()?.itemId, 'old');
		assert.equal(model.previous()?.start, 5);
	});

	test('streaming, corrections and prepended history retain a surviving match and retire removed rows', () => {
		let items = [item('live', 'agentMessage', 'first term')];
		using model = new ChatFindModel(() => items);
		model.setQuery('term', defaults);
		items = [item('older', 'userMessage', 'term'), item('live', 'agentMessage', 'first term then term')];
		model.recompute();
		assert.equal(model.activeIndex, 1);
		assert.equal(model.activeMatch?.start, 6);
		items = [item('live', 'agentMessage', 'corrected')];
		model.recompute();
		assert.deepEqual(model.matches, []);
	});

	test('caps matches and releases the derived index on clear', () => {
		using model = new ChatFindModel(() => [item('many', 'userMessage', 'a '.repeat(MAX_FIND_MATCHES + 2))]);
		model.setQuery('a', defaults);
		assert.equal(model.matches.length, MAX_FIND_MATCHES);
		assert.equal(model.isTruncated, true);
		model.clear();
		assert.equal(model.query, '');
		assert.equal(model.activeIndex, -1);
		assert.equal(model.isTruncated, false);
		assert.equal(model.matches.length, 0);
	});
});
