import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../browser/dom.js';
import { PagedList, type IPagedRenderer } from '../../browser/ui/list/listPaging.js';
import { DeferredPromise } from '../../common/async.js';
import type { CancellationToken } from '../../common/cancellation.js';
import { Emitter } from '../../common/event.js';
import type { IPagedModel } from '../../common/paging.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();

test('PagedList resolves only rendered placeholders and preserves attached actions when a page arrives', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using lengthChanged = new Emitter<number>();
		const pending = new DeferredPromise<string>();
		const resolved = Array.from({ length: 50 }, (_, index) => `Commit ${index}`);
		let reads = 0;
		const model: IPagedModel<string> = {
			get length() { return resolved.length === 50 ? 51 : resolved.length; },
			onDidIncrementLength: lengthChanged.event,
			isResolved: index => index < resolved.length,
			get: index => resolved[index]!,
			resolve: () => { reads++; return pending.p; },
		};
		const renderer: IPagedRenderer<string, HTMLElement> = {
			templateId: 'commit',
			renderTemplate: container => container,
			renderElement: (value, _index, container) => {
				if (container.firstChild) {
					container.firstChild.textContent = value;
				} else {
					container.append(h(dom.window.document, 'button', undefined, value));
				}
			},
			renderPlaceholder: (_index, container) => { container.textContent = 'Loading'; },
			disposeTemplate: container => container.replaceChildren(),
		};
		using list = new PagedList('History', dom.window.document.body, {
			getHeight: () => 20,
			getTemplateId: () => 'commit',
		}, [renderer], { mouseSupport: false, keyboardSupport: false });
		const viewport = list.widget.domNode.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		Object.defineProperties(viewport, {
			clientWidth: { value: 100 },
			clientHeight: { value: 80 },
			scrollHeight: { value: 1100 },
		});
		list.model = model;
		assert.equal(reads, 0);
		viewport.scrollTop = 960;
		viewport.dispatchEvent(new dom.window.Event('scroll'));
		const action = list.widget.row(48)!.querySelector('button')!;
		action.focus();
		list.widget.layout(80);
		assert.equal(reads, 1);
		resolved.push('Commit 50', 'Commit 51', 'Commit 52', 'Commit 53', 'Commit 54');
		lengthChanged.fire(resolved.length);
		await pending.complete('Commit 50');
		assert.deepEqual({ reads, length: list.widget.items.length, scrollTop: viewport.scrollTop }, { reads: 1, length: 55, scrollTop: 960 });
		assert.equal(dom.window.document.activeElement, action);
		assert.equal(list.widget.row(48)!.querySelector('button'), action);
		assert.equal(list.widget.row(50)!.textContent, 'Commit 50');
	} finally {
		dom.window.close();
	}
});

test('PagedList cancels obsolete resolutions and disposes templates when its model changes', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using lengthChanged = new Emitter<number>();
		const pending = new DeferredPromise<string>();
		let token: CancellationToken | undefined;
		let templates = 0;
		let disposed = 0;
		const renderer: IPagedRenderer<string, HTMLElement> = {
			templateId: 'item',
			renderTemplate: container => { templates++; return container; },
			renderElement: (value, _index, container) => { container.textContent = value; },
			renderPlaceholder: (_index, container) => { container.textContent = 'Loading'; },
			disposeTemplate: () => { disposed++; },
		};
		using list = new PagedList('Items', dom.window.document.body, {
			getHeight: () => 20,
			getTemplateId: () => 'item',
		}, [renderer]);
		const viewport = list.widget.domNode.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		Object.defineProperties(viewport, {
			clientWidth: { value: 100 },
			clientHeight: { value: 80 },
			scrollHeight: { value: 80 },
		});
		list.model = {
			length: 1,
			onDidIncrementLength: lengthChanged.event,
			isResolved: () => false,
			get: () => { throw new Error('Unresolved'); },
			resolve: (_index, cancellation) => { token = cancellation; return pending.p; },
		};
		list.model = {
			length: 1,
			onDidIncrementLength: lengthChanged.event,
			isResolved: () => true,
			get: () => 'Current',
			resolve: async () => 'Current',
		};
		assert.equal(token!.isCancellationRequested, true);
		await pending.complete('Obsolete');
		assert.equal(list.widget.row(0)!.textContent, 'Current');
		list.dispose();
		assert.deepEqual({ templates, disposed }, { templates: 2, disposed: 2 });
	} finally {
		dom.window.close();
	}
});

test('PagedList keeps failed placeholders available for an explicit retry', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using lengthChanged = new Emitter<number>();
		const failed = new DeferredPromise<string>();
		const renderedFailure = new DeferredPromise<void>();
		const retried = new DeferredPromise<void>();
		let reads = 0;
		const renderer: IPagedRenderer<string, HTMLElement> = {
			templateId: 'item',
			renderTemplate: container => container,
			renderElement: (value, _index, container) => { container.textContent = value; void retried.complete(); },
			renderPlaceholder: (_index, container) => {
				container.textContent = reads ? 'Retry' : 'Loading';
				if (reads) void renderedFailure.complete();
			},
			disposeTemplate: container => container.replaceChildren(),
		};
		using list = new PagedList('Items', dom.window.document.body, {
			getHeight: () => reads > 1 ? 40 : 20,
			getTemplateId: () => 'item',
		}, [renderer], {
			role: 'tree',
			accessibilityProvider: {
				getRole: () => 'treeitem',
				getAriaLabel: value => value,
				getAriaLevel: () => 2,
				getAriaSetSize: () => 1,
				getAriaPosInSet: () => 1,
				isExpanded: () => false,
			},
		});
		const viewport = list.widget.domNode.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		Object.defineProperties(viewport, {
			clientWidth: { value: 100 },
			clientHeight: { value: 80 },
			scrollHeight: { value: 80 },
		});
		list.model = {
			length: 1,
			onDidIncrementLength: lengthChanged.event,
			isResolved: () => reads > 1,
			get: () => 'Loaded',
			resolve: () => ++reads === 1 ? failed.p : Promise.resolve('Loaded'),
		};
		await failed.error(new Error('Request failed'));
		await renderedFailure.p;
		assert.deepEqual({ reads, text: list.widget.row(0)!.textContent }, { reads: 1, text: 'Retry' });
		list.widget.rerender(0);
		await retried.p;
		assert.deepEqual({ reads, text: list.widget.row(0)!.textContent }, { reads: 2, text: 'Loaded' });
		const row = list.widget.row(0)!;
		assert.deepEqual(['role', 'aria-label', 'aria-level', 'aria-setsize', 'aria-posinset', 'aria-expanded'].map(name => row.getAttribute(name)), ['treeitem', 'Loaded', '2', '1', '1', 'false']);
		assert.deepEqual({ height: list.widget.getElementHeight(0), style: row.style.height }, { height: 40, style: '40px' });
	} finally {
		dom.window.close();
	}
});

test('PagedList cancels hidden row requests and resolves them again when the viewport returns', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using lengthChanged = new Emitter<number>();
		const first = new DeferredPromise<string>();
		const second = new DeferredPromise<string>();
		const rendered = new DeferredPromise<void>();
		const tokens: CancellationToken[] = [];
		let value: string | undefined;
		const renderer: IPagedRenderer<string, HTMLElement> = {
			templateId: 'item',
			renderTemplate: container => container,
			renderElement: (value, _index, container) => { container.textContent = value; void rendered.complete(); },
			renderPlaceholder: (_index, container) => { container.textContent = 'Loading'; },
			disposeTemplate: container => container.replaceChildren(),
		};
		using list = new PagedList('Items', dom.window.document.body, {
			getHeight: () => 20,
			getTemplateId: () => 'item',
		}, [renderer], { mouseSupport: false, keyboardSupport: false });
		const viewport = list.widget.domNode.querySelector<HTMLElement>('.ash-scrollbar-viewport')!;
		let height = 80;
		Object.defineProperties(viewport, {
			clientWidth: { value: 100 },
			clientHeight: { get: () => height },
			scrollHeight: { value: 80 },
		});
		list.model = {
			length: 1,
			onDidIncrementLength: lengthChanged.event,
			isResolved: () => value !== undefined,
			get: () => value!,
			resolve: async (_index, token) => {
				tokens.push(token);
				const result = await (tokens.length === 1 ? first.p : second.p);
				if (!token.isCancellationRequested) {
					value = result;
				}
				return result;
			},
		};
		height = 0;
		list.widget.layout(0);
		assert.equal(tokens[0]!.isCancellationRequested, true);
		height = 80;
		list.widget.layout(80);
		assert.equal(tokens.length, 2);
		await first.complete('Hidden');
		assert.equal(list.widget.row(0)!.textContent, 'Loading');
		await second.complete('Visible');
		await rendered.p;
		assert.equal(list.widget.row(0)!.textContent, 'Visible');
	} finally {
		dom.window.close();
	}
});
