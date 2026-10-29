import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import type { IListRenderer } from '../../browser/ui/list/list.js';
import { RowCache } from '../../browser/ui/list/rowCache.js';
import { ListView } from '../../browser/ui/list/listView.js';
import { h } from '../../browser/dom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('RowCache reuses templates by type and disposes leased and released templates once', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	let created = 0;
	let disposed = 0;
	const renderers = new Map<string, IListRenderer<number, HTMLElement>>();
	for (const templateId of ['item', 'separator']) {
		renderers.set(templateId, {
			templateId,
			renderTemplate: container => { created++; return container; },
			renderElement: (value, _index, container) => { container.textContent = String(value); },
			disposeTemplate: () => { disposed++; },
		});
	}
	try {
		using cache = new RowCache(renderers, dom.window.document);
		const item = cache.alloc('item').row;
		const separator = cache.alloc('separator').row;
		cache.release(item);
		assert.equal(cache.alloc('item').row, item);
		assert.notEqual(separator, item);
		assert.equal(created, 2);
		cache.release(separator);
		cache.dispose();
		assert.equal(disposed, 2);
		cache.dispose();
		assert.equal(disposed, 2);
	} finally { dom.window.close(); }
});

test('RowCache transactions reuse attached rows and detach unused rows even if rendering throws', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		const renderer: IListRenderer<number, HTMLElement> = {
			templateId: 'item',
			renderTemplate: container => container,
			renderElement: (value, _index, container) => { container.textContent = String(value); },
			disposeTemplate: container => container.replaceChildren(),
		};
		using cache = new RowCache(new Map([[renderer.templateId, renderer]]), dom.window.document);
		const first = cache.alloc('item').row;
		const second = cache.alloc('item').row;
		dom.window.document.body.append(first.domNode, second.domNode);
		assert.throws(() => cache.transact(() => {
			cache.release(first);
			cache.release(second);
			const reused = cache.alloc('item');
			assert.equal(reused.row, second);
			assert.equal(reused.isReusingConnectedDomNode, true);
			throw new Error('Render failed');
		}), /Render failed/);
		assert.equal(first.domNode.isConnected, false);
		assert.equal(second.domNode.isConnected, true);
	} finally { dom.window.close(); }
});

test('ListView template allocation stabilizes across repeated scrolling and releases element resources', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const shells = new Set<HTMLElement>();
	const active = new Set<number>();
	try {
		using view = new ListView<number>(dom.window.document.body, {
			scrolling: 'managed',
			getId: String,
			getHeight: () => 20,
			renderItem: (item, _index, row) => {
				shells.add(row);
				active.add(item);
				return h(dom.window.document, 'span', undefined, `Item ${item}`);
			},
			onDidRemoveRow: row => { active.delete(Number(row.dataset.listId)); },
		});
		const viewport = view.scrollElement;
		Object.defineProperties(viewport, {
			clientWidth: { value: 100 },
			clientHeight: { value: 80 },
			scrollHeight: { value: 10_000 },
		});
		view.items = Array.from({ length: 500 }, (_, index) => index);
		const scrollThrough = (): void => {
			view.scrollBy(-10_000);
			for (let index = 0; index < 20; index++) view.scrollBy(500);
		};
		scrollThrough();
		const allocated = shells.size;
		scrollThrough();
		assert.equal(shells.size, allocated);
		assert.ok(allocated < 60, 'Templates stay bounded by the rendered range');
		const rows = [...view.element.querySelectorAll<HTMLElement>('.ash-list-row')];
		assert.equal(active.size, rows.length);
		for (const row of rows) assert.equal(row.textContent, `Item ${row.dataset.listId}`);
		view.dispose();
		assert.equal(active.size, 0);
	} finally { dom.window.close(); }
});
