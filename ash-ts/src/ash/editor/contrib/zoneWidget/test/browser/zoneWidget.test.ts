import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { h } from '../../../../../base/browser/dom.js';
import { Color } from '../../../../../base/common/color.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { Selection } from '../../../../common/core/selection.js';
import { TextModel } from '../../../../common/model/textModel.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	MouseEvent: browserEnvironment.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { EditorLineWrapping } = await import('../../../../common/config/editorOptions.js');
const { ZoneWidget } = await import('../../browser/zoneWidget.js');

test('ZoneWidget reserves editor space, tracks its anchor, updates layout, and releases its zone', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha\nbeta\ngamma');
	using editor = createTestCodeEditor({
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	editor.layout({ width: 200, height: 100 });
	const viewport = editor.view;
	using widget = new TestZoneWidget(editor, {
		className: 'peek-widget test-widget',
		frameWidth: 2,
		frameColor: '#123456',
		arrowColor: Color.fromHex('#654321'),
		ordinal: 20,
	});
	widget.create();

	widget.show(new Position((1) + 1, (2) + 1), 2);

	assert.deepEqual({
		position: widget.position,
		parent: widget.domNode.parentElement,
		top: widget.domNode.style.top,
		height: widget.domNode.style.height,
		contentHeight: viewport.viewportLayout.contentSize.height,
		classes: [...widget.domNode.classList],
		layout: widget.layouts.at(-1),
		frameColor: widget.domNode.style.getPropertyValue('--stanza-zone-widget-frame-color'),
		arrowColor: widget.domNode.style.getPropertyValue('--stanza-zone-widget-arrow-color'),
		revealedRanges: widget.revealedRanges,
	}, {
		position: new Position((1) + 1, (2) + 1),
		parent: requiredElement(viewport.domNode.domNode, '.stanza-editor-view-zones'),
		top: '40px',
		height: '40px',
		contentHeight: 100,
		classes: ['stanza-editor-zone-widget', 'peek-widget', 'test-widget', 'show-frame', 'show-arrow', 'stanza-editor-view-zone'],
		layout: { heightInPixels: 22, widthInPixels: 160 },
		frameColor: '#123456',
		arrowColor: '#654321',
		revealedRanges: [Range.fromPositions(new Position((1) + 1, (2) + 1))],
	});
	editor.layout({ width: 240, height: 100 });
	assert.deepEqual({ height: widget.domNode.style.height, layout: widget.layouts.at(-1) }, {
		height: '40px',
		layout: { heightInPixels: 22, widthInPixels: 193 },
	});
	editor.layout({ width: 200, height: 100 });

	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: 'new\n' }]);
	assert.deepEqual({ position: widget.position, top: widget.domNode.style.top }, {
		position: new Position((2) + 1, (2) + 1),
		top: '60px',
	});

	widget.updatePositionAndHeight(new Position((0) + 1, (1) + 1), 1);
	assert.deepEqual({
		position: widget.position,
		top: widget.domNode.style.top,
		height: widget.domNode.style.height,
		contentHeight: viewport.viewportLayout.contentSize.height,
		layout: widget.layouts.at(-1),
	}, {
		position: new Position((0) + 1, (1) + 1),
		top: '20px',
		height: '20px',
		contentHeight: 100,
		layout: { heightInPixels: 2, widthInPixels: 160 },
	});

	widget.style({ frameColor: '#abcdef', arrowColor: null });
	assert.equal(widget.domNode.style.getPropertyValue('--stanza-zone-widget-frame-color'), '#abcdef');
	assert.equal(widget.domNode.style.getPropertyValue('--stanza-zone-widget-arrow-color'), '');

	widget.hide();
	assert.deepEqual({
		position: widget.position,
		parent: widget.domNode.parentElement,
		hidden: widget.domNode.hidden,
		contentHeight: viewport.viewportLayout.contentSize.height,
	}, {
		position: undefined,
		parent: null,
		hidden: true,
		contentHeight: 100,
	});
	dom.window.close();
});

test('ZoneWidget preserves selection on request and exposes an enabled resize sash while shown', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha\nbeta');
	using editor = createTestCodeEditor({
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	editor.layout({ width: 200, height: 40 });
	const viewport = editor.view;
	const initialSelection = Selection.fromPositions(new Position(2, 2));
	editor.setSelection(initialSelection);
	using widget = new TestZoneWidget(editor, {
		showFrame: false,
		showArrow: false,
		isAccessible: true,
		isResizeable: true,
		keepEditorSelection: true,
	});
	widget.create();
	widget.show(new Position((0) + 1, (0) + 1), 6);

	const sash = requiredElement<HTMLElement>(widget.domNode, '.ash-sash-horizontal');
	assert.deepEqual({
		selection: editor.getSelection(),
		ariaHidden: widget.domNode.getAttribute('aria-hidden'),
		role: widget.domNode.getAttribute('role'),
		height: widget.domNode.style.height,
		sashHidden: sash.hidden,
		sashDisabled: sash.getAttribute('aria-disabled'),
	}, {
		selection: initialSelection,
		ariaHidden: null,
		role: null,
		height: '120px',
		sashHidden: false,
		sashDisabled: 'false',
	});

	widget.resizeTo(8);
	assert.deepEqual({ height: widget.domNode.style.height, layout: widget.layouts.at(-1) }, {
		height: '160px',
		layout: { heightInPixels: 160, widthInPixels: 160 },
	});
	dom.window.close();
});

test('ZoneWidget places an anchor after its wrapped visual line', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('abcdefghijklmnopqrst');
	using editor = createTestCodeEditor({
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		model,
		input: { resource: model.uri },
		languageId: model.getLanguageId(),
		lineHeight: 20,
	});
	editor.layout({ width: 100, height: 500 });
	const viewport = editor.view;
	viewport.setLineWrapping(EditorLineWrapping.On);
	const anchor = new Position((0) + 1, (18) + 1);
	const visualLineIndex = viewport.getVisualLineProjection().visualLineIndexAt(anchor);
	assert.ok(visualLineIndex > 0);
	using widget = new TestZoneWidget(editor, { showFrame: false, showArrow: false, keepEditorSelection: true });
	widget.create();

	widget.show(anchor, 1);

	assert.equal(widget.domNode.style.top, `${(visualLineIndex + 1) * 20}px`);
	dom.window.close();
});

class TestZoneWidget extends ZoneWidget {
	public readonly layouts: Array<{ readonly heightInPixels: number; readonly widthInPixels: number }> = [];
	public readonly revealedRanges: Range[] = [];

	public resizeTo(heightInLines: number): void {
		this._relayout(heightInLines);
	}

	protected override _fillContainer(container: HTMLElement): void {
		const content = h(container.ownerDocument, 'button');
		content.textContent = 'Content';
		container.append(content);
	}

	protected override _doLayout(heightInPixels: number, widthInPixels: number): void {
		this.layouts.push({ heightInPixels, widthInPixels });
	}

	protected override revealRange(range: Range, isLastLine: boolean): void {
		this.revealedRanges.push(range);
		super.revealRange(range, isLastLine);
	}
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}
