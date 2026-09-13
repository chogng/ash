import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type TextMeasurer } from "../../common/viewModel/textMeasurer.js";
import { EditorHitTargetKind, hitTestStanzaEditorPoint } from "../../common/viewModel/pointerHitTest.js";
import { Position } from "../../common/core/position.js";
import { TextModel } from "../../common/model/textModel.js";
import { ContentWidgetPositionPreference, type IContentWidget, type IEditorMouseEvent, type IViewZoneChangeAccessor, MouseTargetType } from '../../browser/editorBrowser.js';

class FixedTextMeasurer implements TextMeasurer {
	readonly horizontalPadding = 24;
	readonly contentLeftPadding = 12;

	refresh(): boolean {
		return false;
	}

	measureLineWidth(text: string): number {
		let width = 0;
		for (const character of text) {
			if (character === "\t") {
				width = (Math.floor(width / 40) + 1) * 40;
			} else {
				width += 10;
			}
		}
		return width;
	}
}

test("Pointer hit testing distinguishes gutter, text, empty content, and lines", () => {
	using model = new TextModel("a\tb\n😀a\n");
	const measurer = new FixedTextMeasurer();
	const layout = {
		lineHeight: 20,
		viewportSize: { width: 200, height: 80 },
		scrollPosition: { left: 0, top: 0 },
	};
	const metrics = { gutterWidth: 30, textLeft: 40 };
	const hit = (left: number, top: number) => hitTestStanzaEditorPoint(
		model,
		layout,
		{ left, top },
		metrics,
		measurer,
	);

	assert.equal(hit(-1, 0), undefined);
	assert.equal(hit(0, 80), undefined);
	assert.throws(() => hitTestStanzaEditorPoint(
		model,
		{ ...layout, lineHeight: 0 },
		{ left: 0, top: 0 },
		metrics,
		measurer,
	), /layout is invalid/);
	assert.deepEqual(hit(10, 25), {
		kind: EditorHitTargetKind.Gutter,
		position: new Position((1) + 1, (0) + 1),
	});
	assert.deepEqual(hit(35, 5), {
		kind: EditorHitTargetKind.EmptyContent,
		position: new Position((0) + 1, (0) + 1),
	});
	assert.deepEqual(hit(54, 5), {
		kind: EditorHitTargetKind.Text,
		position: new Position((0) + 1, (1) + 1),
	});
	assert.deepEqual(hit(65, 5), {
		kind: EditorHitTargetKind.Text,
		position: new Position((0) + 1, (2) + 1),
	});
	assert.deepEqual(hit(86, 5), {
		kind: EditorHitTargetKind.Text,
		position: new Position((0) + 1, (3) + 1),
	});
	assert.deepEqual(hit(100, 5), {
		kind: EditorHitTargetKind.EmptyContent,
		position: new Position((0) + 1, (3) + 1),
	});
	assert.deepEqual(hit(44, 25), {
		kind: EditorHitTargetKind.Text,
		position: new Position((1) + 1, (0) + 1),
	});
	assert.deepEqual(hit(45, 25), {
		kind: EditorHitTargetKind.Text,
		position: new Position((1) + 1, (2) + 1),
	});
	assert.deepEqual(hit(40, 45), {
		kind: EditorHitTargetKind.EmptyContent,
		position: new Position((2) + 1, (0) + 1),
	});
	assert.deepEqual(hit(40, 65), {
		kind: EditorHitTargetKind.AfterLines,
		position: new Position((2) + 1, (0) + 1),
	});
});

test("Pointer hit testing applies sticky gutter and viewport scrolling", () => {
	using model = new TextModel("first\n😀a\nthird");
	const layout = {
		lineHeight: 20,
		viewportSize: { width: 100, height: 40 },
		scrollPosition: { left: 20, top: 20 },
	};
	const metrics = { gutterWidth: 30, textLeft: 40 };

	assert.deepEqual(hitTestStanzaEditorPoint(
		model,
		layout,
		{ left: 10, top: 5 },
		metrics,
		new FixedTextMeasurer(),
	), {
		kind: EditorHitTargetKind.Gutter,
		position: new Position((1) + 1, (0) + 1),
	});
	assert.deepEqual(hitTestStanzaEditorPoint(
		model,
		layout,
		{ left: 30, top: 5 },
		metrics,
		new FixedTextMeasurer(),
	), {
		kind: EditorHitTargetKind.Text,
		position: new Position((1) + 1, (2) + 1),
	});
});

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const { TestView: View } = await import(
	"./viewModel/testViewModel.js"
);
test('View zones expose one accessor lifetime and stable pointer identity', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(container);
	using model = new TextModel('first\nsecond');
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	viewport.layout({ width: 200, height: 80 });
	viewport.domNode.domNode.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 80, width: 200, height: 80, toJSON: () => ({}) });
	const domNode = dom.window.document.createElement('div');
	let accessor: IViewZoneChangeAccessor | undefined;
	let id = '';
	let computedHeight = 0;
	viewport.changeViewZones(value => {
		accessor = value;
		id = value.addZone({ afterLineNumber: 1, heightInPx: 20, suppressMouseDown: true, domNode, onComputedHeight: height => { computedHeight = height; } });
	});

	assert.equal(computedHeight, 20);
	assert.throws(() => accessor!.layoutZone(id), /no longer valid/);
	let mouseDown: IEditorMouseEvent | undefined;
	viewport.controller.userInputEvents.onMouseDown = event => { mouseDown = event; };
	domNode.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 60, clientY: 25 }));
	assert.equal(mouseDown?.target.type, MouseTargetType.CONTENT_VIEW_ZONE);
	assert.equal(mouseDown?.target.type === MouseTargetType.CONTENT_VIEW_ZONE ? mouseDown.target.detail.viewZoneId : undefined, id);
	viewport.changeViewZones(value => value.removeZone(id));
	assert.equal(domNode.parentElement, null);
	dom.window.close();
});

test('Content widget pointer identity comes from the registered widget owner', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector<HTMLElement>('main');
	assert.ok(container);
	using model = new TextModel('first');
	using viewport = new View({ container, model, lineHeight: 20, textMeasurer: new FixedTextMeasurer() });
	viewport.layout({ width: 200, height: 60 });
	const widgetNode = dom.window.document.createElement('div');
	const nested = dom.window.document.createElement('span');
	widgetNode.append(nested);
	const widget: IContentWidget = {
		suppressMouseDown: true,
		getId: () => 'pointer.content.widget',
		getDomNode: () => widgetNode,
		getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
	};
	viewport.addContentWidget(widget);

	let mouseDown: IEditorMouseEvent | undefined;
	viewport.controller.userInputEvents.onMouseDown = event => { mouseDown = event; };
	nested.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 50, clientY: 10 }));
	assert.equal(mouseDown?.target.type, MouseTargetType.CONTENT_WIDGET);
	assert.equal(mouseDown?.target.type === MouseTargetType.CONTENT_WIDGET ? mouseDown.target.detail : undefined, 'pointer.content.widget');
	viewport.removeContentWidget(widget);
	dom.window.close();
});

test("Viewport maps client coordinates through its bounds and scroll state", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const container = dom.window.document.querySelector("main");
	assert.ok(container);
	using model = new TextModel(
		Array.from({ length: 20 }, () => "abcdefghij".repeat(3)).join("\n"),
	);
	using viewport = new View({
		container,
		model,
		glyphMargin: false,
		lineHeight: 20,
		textMeasurer: new FixedTextMeasurer(),
	});
	viewport.layout({ width: 100, height: 40 });
	viewport.scrollTo({ left: 20, top: 20 });
	viewport.domNode.domNode.getBoundingClientRect = () => ({
		x: 100,
		y: 50,
		left: 100,
		top: 50,
		right: 200,
		bottom: 90,
		width: 100,
		height: 40,
		toJSON: () => ({}),
	});
	const textClientX = 100 + viewport.getLayoutInfo().contentLeft + 2;

	assert.deepEqual(viewport.getTargetAtClientPoint({
		clientX: 110,
		clientY: 55,
	}), {
		kind: EditorHitTargetKind.Gutter,
		position: new Position((1) + 1, (0) + 1),
	});
	assert.deepEqual(viewport.getTargetAtClientPoint({
		clientX: textClientX,
		clientY: 55,
	}), {
		kind: EditorHitTargetKind.Text,
		position: new Position((1) + 1, (1) + 1),
		viewPosition: new Position((1) + 1, (1) + 1),
		injectedText: null,
	});
	assert.equal(viewport.getTargetAtClientPoint({
		clientX: 99,
		clientY: 55,
	}), undefined);
	assert.deepEqual(viewport.getNearestTargetAtClientPoint({
		clientX: 50,
		clientY: 55,
	}), {
		kind: EditorHitTargetKind.Gutter,
		position: new Position((1) + 1, (0) + 1),
	});
	assert.deepEqual(viewport.getNearestTargetAtClientPoint({
		clientX: textClientX,
		clientY: 100,
	}), {
		kind: EditorHitTargetKind.Text,
		position: new Position((2) + 1, (1) + 1),
		viewPosition: new Position((2) + 1, (1) + 1),
		injectedText: null,
	});
	assert.throws(() => viewport.getTargetAtClientPoint({
		clientX: Number.NaN,
		clientY: 55,
	}), /finite coordinates/);

	dom.window.close();
});
