import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ViewLineOptions } from '../../browser/viewParts/viewLines/viewLineOptions.js';
import { ColorScheme } from '../../../platform/theme/common/theme.js';
import { createTestConfiguration } from './config/testConfiguration.js';

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

const { SemanticTokenPresentation } = await import('../../browser/viewParts/viewLines/viewLine.js');
const { ViewLine } = await import('../../browser/viewParts/viewLines/viewLine.js');
const { DomReadingContext } = await import('../../browser/viewParts/viewLines/domReadingContext.js');

test('ViewLine owns rendering, character mapping, geometry, and width state', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using configuration = createTestConfiguration(dom.window.document.body, { renderWhitespace: 'none' });
	const line = new ViewLine(dom.window.document.body, 0, new ViewLineOptions(configuration, ColorScheme.Dark), 4);
	const row = line.getDomNode();
	const textElement = row.firstElementChild as HTMLElement;
	assert.equal(row.children.length, 1);
	assert.equal(line.renderLine('ab😊cd', [{ startColumn: 2, endColumn: 4, presentation: SemanticTokenPresentation.String }], []), true);
	assert.equal(textElement.textContent, 'ab😊cd');
	assert.deepEqual([...textElement.children].map(child => child.textContent), ['ab', '😊', 'cd']);
	assert.equal(line.getColumnOfNodeOffset(textElement.children[2] as HTMLElement, 1), 6);

	Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => rectangle(100, 0, 100) });
	Object.defineProperty(row, 'offsetWidth', { configurable: true, value: 100 });
	Object.defineProperty(textElement, 'getBoundingClientRect', { configurable: true, value: () => rectangle(100, 0, 50) });
	const createRange = dom.window.document.createRange.bind(dom.window.document);
	Object.defineProperty(dom.window.document, 'createRange', {
		configurable: true,
		value: () => {
			const range = createRange();
			Object.defineProperty(range, 'getClientRects', { configurable: true, value: () => [rectangle(130, 0, 0)] });
			return range;
		},
	});
	const context = new DomReadingContext(row, textElement);
	assert.equal(line.getVisibleRangesForRange(1, 5, 5, context)?.ranges[0]?.left, 30);
	assert.equal(line.getWidthIsFast(), false);
	assert.equal(line.getWidth(context), 50);
	assert.equal(line.getWidthIsFast(), true);
	assert.equal(line.needsMonospaceFontCheck(), true);
	assert.equal(line.monospaceAssumptionsAreValid(), false);
	line.onMonospaceAssumptionsInvalidated();
	assert.equal(line.needsMonospaceFontCheck(), false);
	assert.equal(line.monospaceAssumptionsAreValid(), true);
	line.resetCachedWidth();
	assert.equal(line.getWidthIsFast(), false);
	assert.equal(line.onSelectionChanged(), false);
	line.onOptionsChanged(new ViewLineOptions(configuration, ColorScheme.HighContrastDark));
	assert.equal(line.onSelectionChanged(), true);
	dom.window.close();
});

function rectangle(left: number, top: number, width: number): DOMRect {
	return { left, top, width, height: 20, right: left + width, bottom: top + 20, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}
