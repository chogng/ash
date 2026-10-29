import './testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ViewLineOptions } from '../../browser/viewParts/viewLines/viewLineOptions.js';
import { ColorScheme } from '../../../platform/theme/common/theme.js';
import { Range } from '../../common/core/range.js';
import { InlineDecoration, InlineDecorationType } from '../../common/viewModel/inlineDecorations.js';
import { createTestConfiguration } from './config/testConfiguration.js';

const { SemanticTokenPresentation } = await import('../../browser/viewParts/viewLines/viewLine.js');
const { ViewLine } = await import('../../browser/viewParts/viewLines/viewLine.js');
const { DomReadingContext } = await import('../../browser/viewParts/viewLines/domReadingContext.js');

test('ViewLine clips spanning inline decorations to each visible row', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using configuration = createTestConfiguration(dom.window.document.body, { renderWhitespace: 'none' });
		const decoration = new InlineDecoration(new Range(1, 2, 3, 2), 'spanning-reference', InlineDecorationType.Regular);
		for (const [index, text, marked] of [
			[0, 'first', 'irst'],
			[1, 'middle', 'middle'],
			[2, 'last', 'l'],
		] as const) {
			const line = new ViewLine(dom.window.document.body, index, new ViewLineOptions(configuration, ColorScheme.Dark), 4);
			line.renderLine(text, [], 0, [decoration], index + 1);
			assert.equal(line.getDomNode().textContent, text);
			assert.equal(line.getDomNode().querySelector('.spanning-reference')?.textContent, marked);
		}
	} finally {
		dom.window.close();
	}
});

test('ViewLine owns rendering, character mapping, geometry, and width state', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	using configuration = createTestConfiguration(dom.window.document.body, { renderWhitespace: 'none' });
	const line = new ViewLine(dom.window.document.body, 0, new ViewLineOptions(configuration, ColorScheme.Dark), 4);
	const row = line.getDomNode();
	const textElement = row.firstElementChild as HTMLElement;
	assert.equal(row.children.length, 1);
	assert.equal(line.renderLine('ab😊cd', [{ startColumn: 2, endColumn: 4, presentation: SemanticTokenPresentation.String }]), true);
	assert.equal(textElement.textContent, 'ab😊cd');
	assert.deepEqual(
		[...textElement.children].map(child => child.textContent),
		['ab', '😊', 'cd'],
	);
	assert.equal(line.getColumnOfNodeOffset(textElement.children[2] as HTMLElement, 1), 6);

	Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => rectangle(100, 0, 100) });
	Object.defineProperty(row, 'offsetWidth', { configurable: true, value: 100 });
	Object.defineProperty(textElement, 'getBoundingClientRect', {
		configurable: true,
		value: () => rectangle(100, 0, 50),
	});
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

test('Unchanged token and decoration notifications retain spans and measured widths', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using configuration = createTestConfiguration(dom.window.document.body, {
			renderWhitespace: 'none',
			disableMonospaceOptimizations: true,
		});
		const line = new ViewLine(dom.window.document.body, 0, new ViewLineOptions(configuration, ColorScheme.Dark), 4);
		line.renderLine('sample', [{ startColumn: 0, endColumn: 6, presentation: SemanticTokenPresentation.Keyword }]);
		const textElement = line.getDomNode().firstElementChild as HTMLElement;
		const span = textElement.firstElementChild;
		let measurements = 0;
		Object.defineProperty(textElement, 'offsetWidth', {
			get: () => {
				measurements += 1;
				return 60;
			},
		});
		assert.equal(line.getWidth(null), 60);
		line.onTokensChanged();
		line.onDecorationsChanged();
		assert.equal(line.renderLine('sample', [{ startColumn: 0, endColumn: 6, presentation: SemanticTokenPresentation.Keyword }]), false);
		assert.strictEqual(textElement.firstElementChild, span);
		assert.equal(line.getWidth(null), 60);
		assert.equal(measurements, 1);
		assert.equal(line.getColumnOfNodeOffset(span as HTMLElement, 3), 4);
		line.onTokensChanged();
		assert.equal(line.renderLine('sample', [{ startColumn: 0, endColumn: 6, presentation: SemanticTokenPresentation.String }]), true);
		assert.notStrictEqual(textElement.firstElementChild, span);
		assert.equal(line.getWidth(null), 60);
		assert.equal(measurements, 2);
		assert.ok(textElement.querySelector('.token-string'));
	} finally {
		dom.window.close();
	}
});

test('Indent and font options invalidate geometry even when text spans are unchanged', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using configuration = createTestConfiguration(dom.window.document.body, {
			renderWhitespace: 'none',
			disableMonospaceOptimizations: true,
		});
		const line = new ViewLine(dom.window.document.body, 0, new ViewLineOptions(configuration, ColorScheme.Dark), 4);
		line.renderLine('sample', []);
		const textElement = line.getDomNode().firstElementChild as HTMLElement;
		const span = textElement.firstElementChild;
		Object.defineProperty(textElement, 'offsetWidth', { value: 60 });
		assert.equal(line.getWidth(null), 60);
		assert.equal(line.renderLine('sample', [], 10), true);
		assert.strictEqual(textElement.firstElementChild, span);
		assert.equal(line.getWidth(null), 70);
		line.onOptionsChanged(new ViewLineOptions(configuration, ColorScheme.HighContrastDark));
		assert.equal(line.getWidthIsFast(), false);
	} finally {
		dom.window.close();
	}
});

test('Plain ASCII widths reuse measured font advances and reset eligibility with geometry', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using configuration = createTestConfiguration(dom.window.document.body);
		const options = new ViewLineOptions(configuration, ColorScheme.Dark);
		const line = new ViewLine(dom.window.document.body, 0, options, 4);
		const text = line.getDomNode().firstElementChild as HTMLElement;
		let reads = 0;
		Object.defineProperty(text, 'offsetWidth', {
			get: () => {
				reads++;
				return 91;
			},
		});
		line.renderLine('abc', [{ startColumn: 0, endColumn: 3, presentation: SemanticTokenPresentation.Keyword }], 10);
		assert.equal(line.getWidthIsFast(), true);
		assert.equal(line.getWidth(null), 10 + 3 * options.spaceWidth);
		assert.equal(reads, 0);
		assert.equal(line.needsMonospaceFontCheck(), false, 'Trusted font measurements do not need a check against the derived width');
		line.onTokensChanged();
		line.renderLine('longer', []);
		assert.equal(line.getWidth(null), 6 * options.spaceWidth);
		assert.equal(reads, 0);
		line.onOptionsChanged(options);
		assert.equal(line.getWidthIsFast(), false);
		line.renderLine('longer', []);
		assert.equal(line.getWidth(null), 6 * options.spaceWidth);
		line.resetCachedWidth();
		assert.equal(line.getWidthIsFast(), false);
		assert.equal(line.getWidth(null), 91, 'An explicit geometry reset must allow fresh DOM measurement');
		assert.equal(reads, 1);
		line.onMonospaceAssumptionsInvalidated();
		line.renderLine('plain', []);
		assert.equal(line.getWidth(null), 91);
		assert.equal(reads, 2);
	} finally {
		dom.window.close();
	}
});

test('Complex text, decorations, font styles, ligatures and clipped markers retain DOM widths', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using configuration = createTestConfiguration(dom.window.document.body);
		const line = new ViewLine(dom.window.document.body, 0, new ViewLineOptions(configuration, ColorScheme.Dark), 4);
		const text = line.getDomNode().firstElementChild as HTMLElement;
		let reads = 0;
		Object.defineProperty(text, 'offsetWidth', {
			get: () => {
				reads++;
				return 91;
			},
		});
		for (const value of ['\ttext', '中文', 'ab🙂', 'a\u0000b']) {
			line.renderLine(value, []);
			assert.equal(line.getWidthIsFast(), false);
			assert.equal(line.getWidth(null), 91);
		}
		line.renderLine('abc', [], 0, [new InlineDecoration(new Range(1, 1, 1, 2), 'custom-width', InlineDecorationType.Regular)]);
		assert.equal(line.getWidth(null), 91);
		line.renderLine('abc', [{ startColumn: 0, endColumn: 3, syntaxPresentation: { fontStyle: ['bold'] } }]);
		assert.equal(line.getWidth(null), 91);
		using ligatures = createTestConfiguration(dom.window.document.body, { fontLigatures: true });
		line.onOptionsChanged(new ViewLineOptions(ligatures, ColorScheme.Dark));
		line.renderLine('abc', []);
		assert.equal(line.getWidthIsFast(), false);
		assert.equal(line.getWidth(null), 91);
		using clipped = createTestConfiguration(dom.window.document.body, { stopRenderingLineAfter: 2 });
		line.onOptionsChanged(new ViewLineOptions(clipped, ColorScheme.Dark));
		line.renderLine('abc', []);
		assert.equal(text.textContent, 'ab…');
		assert.equal(line.getWidth(null), 91);
		assert.equal(reads, 8);
	} finally {
		dom.window.close();
	}
});

test('Neutral token styles reuse only a declared normal editor font weight', () => {
	const dom = new JSDOM('<main class="stanza-editor" style="font-weight: normal"></main>');
	try {
		const host = dom.window.document.querySelector<HTMLElement>('main')!;
		using configuration = createTestConfiguration(host);
		const options = new ViewLineOptions(configuration, ColorScheme.Dark);
		const line = new ViewLine(host, 0, options, 4);
		host.append(line.getDomNode());
		const text = line.getDomNode().firstElementChild as HTMLElement;
		let reads = 0;
		Object.defineProperty(text, 'offsetWidth', {
			get: () => {
				reads++;
				return 91;
			},
		});
		const tokens = [{ startColumn: 0, endColumn: 3, syntaxPresentation: { fontStyle: [] } }];
		line.renderLine('abc', tokens);
		assert.equal(line.getWidthIsFast(), true);
		assert.equal(line.getWidth(null), 3 * options.spaceWidth);
		assert.equal(reads, 0);
		host.style.fontWeight = '700';
		line.onOptionsChanged(options);
		line.renderLine('abc', tokens);
		assert.equal(line.getWidthIsFast(), false);
		assert.equal(line.getWidth(null), 91);
		assert.equal(reads, 1);
	} finally {
		dom.window.close();
	}
});

function rectangle(left: number, top: number, width: number): DOMRect {
	return {
		left,
		top,
		width,
		height: 20,
		right: left + width,
		bottom: top + 20,
		x: left,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}
