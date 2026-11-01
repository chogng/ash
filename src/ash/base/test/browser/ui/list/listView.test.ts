import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ListView } from '../../../../browser/ui/list/listView.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../common/utils.js';

suite('ListView streamed row insertion', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

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

suite('ListView render failure cleanup', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('releases a partially rendered row before recovering from a failed splice', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const activeRows = new Set<HTMLElement>();
		const removedItems: string[] = [];
		const renderError = new Error('Render failed');
		try {
			{
				using list = new ListView<string>(dom.window.document.body, {
					getId: item => item,
					renderItem: (item, _index, row) => {
						activeRows.add(row);
						if (item === 'failing') {
							throw renderError;
						}
						return Object.assign(dom.window.document.createElement('span'), { textContent: item });
					},
					onDidRemoveRow: row => {
						activeRows.delete(row);
						removedItems.push(row.dataset.listId!);
					},
				});
				assert.throws(() => list.splice(0, 0, ['retained', 'failing']), error => error === renderError);
				assert.deepEqual(removedItems, ['failing']);
				assert.deepEqual([...activeRows].map(row => row.dataset.listId), ['retained']);

				list.splice(1, 1, ['recovered']);
				assert.deepEqual([...list.element.children].map(row => row.textContent), ['retained', 'recovered']);
				assert.equal(activeRows.size, 2);
			}
			assert.equal(activeRows.size, 0);
			assert.deepEqual(removedItems, ['failing', 'retained', 'recovered']);
		} finally { dom.window.close(); }
	});

	test('releases resources from both the previous row and a failed rerender', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const activeRows = new Set<HTMLElement>();
		let shouldFail = false;
		let removals = 0;
		const renderError = new Error('Rerender failed');
		try {
			{
				using list = new ListView<string>(dom.window.document.body, {
					renderItem: (item, _index, row) => {
						activeRows.add(row);
						if (shouldFail) {
							throw renderError;
						}
						return Object.assign(dom.window.document.createElement('span'), { textContent: item });
					},
					onDidRemoveRow: row => {
						activeRows.delete(row);
						removals++;
					},
				});
				list.items = ['item'];
				assert.equal(activeRows.size, 1);
				shouldFail = true;
				assert.throws(() => list.rerender(0), error => error === renderError);
				assert.equal(activeRows.size, 0);
				assert.equal(list.element.childElementCount, 0);
				assert.equal(removals, 2);
			}
			assert.equal(removals, 2);
		} finally { dom.window.close(); }
	});

	test('disposes a failing list before queued resize observers can render again', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const observations = new Set<TestResizeObserver>();
		class TestResizeObserver implements ResizeObserver {
			constructor(private readonly callback: ResizeObserverCallback) { }
			public observe(): void { observations.add(this); }
			public unobserve(): void { }
			public disconnect(): void { observations.delete(this); }
			public deliver(): void { this.callback([], this); }
		}
		Object.defineProperty(dom.window, 'ResizeObserver', { value: TestResizeObserver });
		const renderedItems: string[] = [];
		const renderError = new Error('Render failed');
		try {
			const resizeDelivery = Promise.resolve().then(() => {
				for (const observer of observations) {
					observer.deliver();
				}
			});
			{
				// Release the deliberately failing renderer before yielding to layout delivery.
				using list = new ListView<string>(dom.window.document.body, {
					scrolling: 'managed',
					renderItem: item => {
						renderedItems.push(item);
						if (item === 'failing') {
							throw renderError;
						}
						return Object.assign(dom.window.document.createElement('span'), { textContent: item });
					},
				});
				assert.ok(observations.size > 0);
				assert.throws(() => list.splice(0, 0, ['retained', 'failing']), error => error === renderError);
			}
			assert.equal(observations.size, 0);
			assert.equal(dom.window.document.body.childElementCount, 0);
			await resizeDelivery;
			assert.deepEqual(renderedItems, ['retained', 'failing']);
		} finally { dom.window.close(); }
	});
});
