import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	NodeFilter: browserEnvironment.window.NodeFilter,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { DomReadingContext } = await import('../../browser/viewParts/viewLines/domReadingContext.js');
const { RangeUtil } = await import('../../browser/viewParts/viewLines/rangeUtil.js');

test('RangeUtil keeps one UTF-16 offset space across syntax spans', () => {
	const dom = new JSDOM('<!doctype html><body><div id="line"><span id="text"><span>ab</span><span>😊</span><span>cd</span></span></div></body>');
	const line = dom.window.document.querySelector<HTMLElement>('#line');
	const text = dom.window.document.querySelector<HTMLElement>('#text');
	assert.ok(line);
	assert.ok(text);
	let selectedText: string | undefined;
	const createRange = dom.window.document.createRange.bind(dom.window.document);
	Object.defineProperty(dom.window.document, 'createRange', {
		configurable: true,
		value: () => {
			const range = createRange();
			Object.defineProperty(range, 'getClientRects', {
				configurable: true,
				value: () => {
					selectedText = range.toString();
					return [rectangle(10, 0, 20)];
				},
			});
			return range;
		},
	});

	assert.deepEqual(RangeUtil.readHorizontalRanges(text, 0, 1, 2, 1, new DomReadingContext(line, text))?.map(({ left, width }) => ({ left, width })), [{ left: 10, width: 20 }]);
	assert.equal(selectedText, 'b😊c');
	dom.window.close();
});

test('DomReadingContext scales, sorts, and merges browser rectangles once', () => {
	const dom = new JSDOM('<!doctype html><body><div id="line"><span id="text"><span>abc אבג</span></span></div></body>');
	const line = dom.window.document.querySelector<HTMLElement>('#line');
	const text = dom.window.document.querySelector<HTMLElement>('#text');
	assert.ok(line);
	assert.ok(text);
	let rootReads = 0;
	Object.defineProperty(line, 'offsetWidth', { configurable: true, value: 100 });
	Object.defineProperty(line, 'getBoundingClientRect', {
		configurable: true,
		value: () => {
			rootReads += 1;
			return rectangle(100, 0, 200);
		},
	});
	const createRange = dom.window.document.createRange.bind(dom.window.document);
	Object.defineProperty(dom.window.document, 'createRange', {
		configurable: true,
		value: () => {
			const range = createRange();
			Object.defineProperty(range, 'getClientRects', {
				configurable: true,
				value: () => [rectangle(150, 0, 20), rectangle(120, 0, 15), rectangle(135.5, 0, 4.5)],
			});
			Object.defineProperty(range, 'getBoundingClientRect', {
				configurable: true,
				value: () => rectangle(135, 0, 0),
			});
			return range;
		},
	});
	const context = new DomReadingContext(line, text);

	assert.deepEqual(RangeUtil.readHorizontalRanges(text, 0, 0, 0, 3, context)?.map(({ left, width }) => ({ left, width })), [
		{ left: 10, width: 10 },
		{ left: 25, width: 10 },
	]);
	assert.equal(context.didDomLayout, true);
	assert.equal(rootReads, 1);
	dom.window.close();
});

function rectangle(left: number, top: number, width: number): DOMRect {
	return { left, top, width, height: 20, right: left + width, bottom: top + 20, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}
