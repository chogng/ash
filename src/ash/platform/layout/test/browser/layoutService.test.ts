import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../../base/browser/dom.js';

const browserEnvironment = new JSDOM('<!doctype html><html><head></head><body></body></html>');
Object.defineProperty(globalThis, 'window', { configurable: true, value: browserEnvironment.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: browserEnvironment.window.document });
Object.defineProperty(globalThis, 'Node', { configurable: true, value: browserEnvironment.window.Node });

const { Dimension } = await import('../../../../base/browser/dom.js');
const { BrowserLayoutService } = await import('../../browser/layoutService.js');

test('BrowserLayoutService publishes root geometry and container offsets', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const root = h(dom.window.document, 'main');
	dom.window.document.body.append(root);
	const primaryWindow = dom.window as unknown as Window;
	let focused = 0;
	const layoutEvents: string[] = [];
	const service = new BrowserLayoutService({
		root,
		focus: () => focused++,
		getContainerOffset: () => ({ top: 36, quickInputTop: 48 }),
	});
	service.onDidLayoutContainer(({ container, dimension }) => {
		assert.equal(container, root);
		assert.deepEqual(dimension, new Dimension(800, 600));
		layoutEvents.push('container');
	});
	service.onDidLayoutMainContainer((dimension) => {
		assert.deepEqual(dimension, new Dimension(800, 600));
		layoutEvents.push('main');
	});
	service.onDidLayoutActiveContainer((dimension) => {
		assert.deepEqual(dimension, new Dimension(800, 600));
		layoutEvents.push('active');
	});

	service.layout(new Dimension(800, 600));

	assert.deepEqual(layoutEvents, ['container', 'main', 'active']);
	assert.deepEqual(service.mainContainerDimension, new Dimension(800, 600));
	assert.deepEqual(service.activeContainerDimension, new Dimension(800, 600));
	assert.equal(service.mainContainer, root);
	assert.equal(service.activeContainer, root);
	assert.deepEqual([...service.containers], [root]);
	assert.deepEqual(service.mainContainerOffset, { top: 36, quickInputTop: 48 });
	assert.deepEqual(service.activeContainerOffset, { top: 36, quickInputTop: 48 });
	assert.equal(service.getContainer(primaryWindow), root);
	assert.equal(service.whenContainerStylesLoaded(primaryWindow), undefined);
	service.focus();
	assert.equal(focused, 1);

	const otherWindow = new JSDOM('<!doctype html><body></body>').window;
	const otherBrowserWindow = otherWindow as unknown as Window;
	assert.throws(() => service.getContainer(otherBrowserWindow), /not registered/);
	assert.throws(() => service.whenContainerStylesLoaded(otherBrowserWindow), /not registered/);

	service.dispose();
	otherWindow.close();
	dom.window.close();
});

test('BrowserLayoutService rejects invalid dimensions', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const root = h(dom.window.document, 'main');
	const service = new BrowserLayoutService({ root });

	assert.throws(() => service.layout(new Dimension(-1, 10)), RangeError);
	assert.throws(() => service.layout({ width: Number.NaN, height: 10 }), RangeError);

	service.dispose();
	dom.window.close();
});

test('BrowserLayoutService preserves fractional root geometry on initial measurement and viewport resize', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	try {
		const root = dom.window.document.querySelector('main')!;
		let bounds = { width: 1_000.2, height: 700.8 };
		root.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, bounds.width, bounds.height);
		Object.defineProperties(root, {
			clientWidth: { get: () => Math.round(bounds.width) },
			clientHeight: { get: () => Math.round(bounds.height) },
		});
		using service = new BrowserLayoutService({ root });
		assert.deepEqual(service.mainContainerDimension, new Dimension(1_000.2, 700.8));
		const layouts: { readonly width: number; readonly height: number }[] = [];
		using subscription = service.onDidLayoutMainContainer(size => layouts.push(size));
		bounds = { width: 900.6, height: 600.4 };
		dom.window.dispatchEvent(new dom.window.Event('resize'));
		assert.deepEqual(service.mainContainerDimension, new Dimension(900.6, 600.4));
		assert.deepEqual(layouts, [new Dimension(900.6, 600.4)]);
		service.layout();
		assert.deepEqual(service.mainContainerDimension, new Dimension(900.6, 600.4));
	} finally {
		dom.window.close();
	}
});
