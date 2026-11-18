import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { ChatPillsWidget, createChatPillButton } from '../../browser/chatPills.js';

test('Chat pills preserve focused entries when reordered and release them on removal', () => {
	const { window } = new JSDOM('<body><textarea></textarea><div><span></span><footer></footer></div></body>');
	using windowLifetime = toDisposable(() => window.close());
	const { document } = window;
	const composer = document.querySelector('textarea')!;
	const container = document.querySelector('div')!;
	const before = document.querySelector('footer')!;
	const disposed: string[] = [];
	type Entry = { id: string; label: string; };
	using pills = new ChatPillsWidget<Entry>(container, {
		getId: entry => entry.id,
		before,
		onRemoveFocused: () => composer.focus(),
		create: entry => {
			const resources = new DisposableStore();
			const element = document.createElement('div');
			const button = resources.add(createChatPillButton(element, { label: entry.label }));
			resources.add(toDisposable(() => {
				element.remove();
				disposed.push(entry.id);
			}));
			return Object.assign(resources, {
				element,
				update: (next: Entry) => { button.label = next.label; },
			});
		},
	});
	const a = { id: 'a', label: 'First' };
	const b = { id: 'b', label: 'Second' };
	pills.update([a, b]);
	const [first] = container.querySelectorAll('button');
	first!.focus();

	pills.update([b, { ...a, label: 'Updated' }]);
	assert.equal(document.activeElement, first);
	assert.deepEqual([...container.children].map(child => child.tagName), ['SPAN', 'DIV', 'DIV', 'FOOTER']);
	assert.deepEqual([...container.querySelectorAll('button')].map(button => button.textContent), ['Second', 'Updated']);

	pills.update([b]);
	assert.equal(document.activeElement, composer);
	assert.deepEqual(disposed, ['a']);
	assert.equal(pills.size, 1);
});
