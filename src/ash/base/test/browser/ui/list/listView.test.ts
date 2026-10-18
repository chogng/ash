import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ListView } from '../../../../browser/ui/list/listView.js';

suite('ListView streamed row insertion', () => {
	test('inserts a whole burst with one live DOM mutation', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using list = new ListView<string>(dom.window.document.body, {
				getId: item => item,
				renderItem: item => Object.assign(dom.window.document.createElement('span'), { textContent: item }),
			});
			const observer = new dom.window.MutationObserver(() => { });
			observer.observe(list.element, { childList: true, characterData: true, subtree: true });
			list.items = Array.from({ length: 2_000 }, (_, index) => `line-${index}`);
			const mutations = observer.takeRecords();
			observer.disconnect();
			assert.equal(mutations.length, 1);
			assert.equal(mutations[0]!.addedNodes.length, 2_000);
			assert.deepEqual([...list.element.children].map(row => row.textContent), list.items);
		} finally { dom.window.close(); }
	});

	test('appends a batch around retained controls without moving their DOM or focus', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			using list = new ListView<string>(dom.window.document.body, {
				getId: item => item, reuseRows: true,
				renderItem: item => Object.assign(dom.window.document.createElement('button'), { textContent: item }),
			});
			list.items = ['before', 'source', 'after'];
			const before = list.element.children[0]!;
			const source = list.element.children[1]!;
			const after = list.element.children[2]!;
			const button = source.querySelector('button')!;
			button.focus();
			list.splice(1, 0, ['new-1', 'new-2']);
			list.splice(5, 0, ['tail-1', 'tail-2']);
			assert.equal(list.element.children[0], before);
			assert.equal(list.element.children[3], source);
			assert.equal(list.element.children[4], after);
			assert.equal(dom.window.document.activeElement, button);
			assert.deepEqual([...list.element.children].map(row => row.textContent), ['before', 'new-1', 'new-2', 'source', 'after', 'tail-1', 'tail-2']);
		} finally { dom.window.close(); }
	});

	test('reorders and prepends rows while its container is detached from the document', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		try {
			const container = dom.window.document.createElement('div');
			using list = new ListView<string>(container, {
				getId: item => item, reuseRows: true,
				renderItem: item => Object.assign(dom.window.document.createElement('span'), { textContent: item }),
			});
			list.items = ['a', 'b'];
			const a = list.element.children[0]!;
			const b = list.element.children[1]!;
			assert.equal(list.element.isConnected, false);
			list.items = ['b', 'a'];
			assert.deepEqual([...list.element.children], [b, a]);
			list.splice(0, 0, ['new-1', 'new-2']);
			assert.deepEqual([...list.element.children].map(row => row.textContent), ['new-1', 'new-2', 'b', 'a']);
			assert.equal(list.element.children[2], b);
			assert.equal(list.element.children[3], a);
		} finally { dom.window.close(); }
	});

});
