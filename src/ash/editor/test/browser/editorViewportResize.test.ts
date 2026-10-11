import './testEditorDom.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { EditorZoom } from "../../common/config/editorZoom.js";
import { TextModel } from "../../common/model/textModel.js";
import { installEditorTestGlobals } from './editorTestGlobals.js';
import { scheduleAtNextAnimationFrame } from '../../../base/browser/scheduler.js';
import { EditorLineWrapping } from '../../common/config/editorOptions.js';
import { ContentWidgetPositionPreference, OverlayWidgetPositionPreference } from '../../browser/editorBrowser.js';
import { Position } from '../../common/core/position.js';
import { Selection } from '../../common/core/selection.js';
import { Range } from '../../common/core/range.js';
import { GlyphMarginLane } from '../../common/model.js';

const { TestView: View } = await import("./viewModel/testViewModel.js");

test('resizing publishes geometry immediately and renders the final size in one frame', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('short line\n' + 'long line '.repeat(100));
	using viewport = new View({ container: requiredElement(dom.window.document, 'main'), model, minimap: { enabled: false } });
	try {
		viewport.layout({ width: 400, height: 100 });
		viewport.render(true, false);
		const content = requiredElement<HTMLElement>(viewport.domNode.domNode, '.stanza-editor-content');
		const line = requiredElement(viewport.domNode.domNode, '.view-line');
		const mapping = viewport.getVisualLineProjection();
		const initialWidth = content.style.width;

		viewport.layout({ width: 360, height: 100 });
		viewport.layout({ width: 320, height: 100 });
		assert.equal(viewport.viewportLayout.viewportSize.width, 320);
		assert.equal(content.style.width, initialWidth);
		assert.strictEqual(viewport.getVisualLineProjection(), mapping);

		await new Promise<void>(resolve => {
			const frame = scheduleAtNextAnimationFrame(dom.window as unknown as Window, () => {
				frame.dispose();
				resolve();
			}, -1);
		});
		assert.equal(content.style.width, `${viewport.viewportLayout.contentSize.width}px`);
		assert.strictEqual(requiredElement(viewport.domNode.domNode, '.view-line'), line);
		assert.strictEqual(viewport.getVisualLineProjection(), mapping);

		viewport.setLineWrapping(EditorLineWrapping.On);
		assert.notStrictEqual(viewport.getVisualLineProjection(), mapping);
		assert.ok(viewport.getVisualLineProjection().visualLineCount > model.lineCount);
	} finally {
		viewport.dispose();
		dom.window.close();
	}
});

test('editors finish text rendering before measuring widgets and writing widget positions', async () => {
	const dom = new JSDOM('<!doctype html><body><main id="first"></main><main id="second"></main></body>', { pretendToBeVisual: true });
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using firstModel = new TextModel('first');
	using secondModel = new TextModel('second');
	using first = new View({ container: requiredElement(dom.window.document, '#first'), model: firstModel, minimap: { enabled: false }, fontLigatures: true });
	using second = new View({ container: requiredElement(dom.window.document, '#second'), model: secondModel, minimap: { enabled: false }, fontLigatures: true });
	const phases: string[] = [];
	const measuredText: string[][] = [];
	const lineWidthSnapshots: string[][] = [];
	try {
		for (const [name, view] of [['first', first], ['second', second]] as const) {
			view.addContentWidget({
				getId: () => name,
				getDomNode: () => dom.window.document.createElement('div'),
				getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
				beforeRender: () => {
					phases.push(`measure ${name}`);
					measuredText.push([first, second].map(editor => requiredElement(editor.domNode.domNode, '.stanza-editor-line-text').textContent ?? ''));
					return { width: 10, height: 10 };
				},
				afterRender: () => { phases.push(`write ${name}`); },
			});
			view.layout({ width: 400, height: 100 });
			view.render(true, false);
		}
		phases.length = 0;
		measuredText.length = 0;
		for (const [name, view] of [['first', first], ['second', second]] as const) {
			const text = requiredElement(view.domNode.domNode, '.stanza-editor-line-text');
			text.getBoundingClientRect = () => {
				phases.push(`text ${name}`);
				lineWidthSnapshots.push([first, second].map(editor => requiredElement(editor.domNode.domNode, '.stanza-editor-line-text').textContent ?? ''));
				return new dom.window.DOMRect(0, 0, 100, 20);
			};
		}
		firstModel.setValue('first updated');
		secondModel.setValue('second updated');
		first.layout({ width: 360, height: 100 });
		second.layout({ width: 320, height: 100 });
		first.layout({ width: 300, height: 100 });
		await nextEditorFrame(dom.window as unknown as Window);
		assert.deepEqual({ phases, measuredText }, {
			phases: ['text first', 'text second', 'measure first', 'measure second', 'write first', 'write second'],
			measuredText: [['first updated', 'second updated'], ['first updated', 'second updated']],
		});
		assert.deepEqual(lineWidthSnapshots, [['first updated', 'second'], ['first updated', 'second updated']]);
	} finally {
		first.dispose();
		second.dispose();
		dom.window.close();
	}
});

test('clean editor parts stay untouched and immediate rendering cancels queued work', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('text');
	using view = new View({ container: requiredElement(dom.window.document, 'main'), model, minimap: { enabled: false } });
	let measurements = 0;
	try {
		view.addContentWidget({
			getId: () => 'widget',
			getDomNode: () => dom.window.document.createElement('div'),
			getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
			beforeRender: () => { measurements += 1; return { width: 10, height: 10 }; },
		});
		view.layout({ width: 400, height: 100 });
		view.render(true, false);
		measurements = 0;
		view.layout({ width: 300, height: 100 });
		view.render(true, false);
		assert.equal(measurements, 1);
		await nextEditorFrame(dom.window as unknown as Window);
		view.render(false, false);
		await nextEditorFrame(dom.window as unknown as Window);
		assert.equal(measurements, 1);
		view.controller.setSelection(new Selection(1, 2, 1, 2));
		await nextEditorFrame(dom.window as unknown as Window);
		assert.equal(measurements, 1);

		view.render(false, true);
		view.dispose();
		await nextEditorFrame(dom.window as unknown as Window);
		assert.equal(measurements, 1);
	} finally {
		view.dispose();
		dom.window.close();
	}
});

async function nextEditorFrame(targetWindow: Window): Promise<void> {
	await new Promise<void>(resolve => {
		const frame = scheduleAtNextAnimationFrame(targetWindow, () => {
			frame.dispose();
			resolve();
		}, -1);
	});
}

test('scrolling leaves fixed overlay measurements clean while resize and zone geometry still update them', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel(Array.from({ length: 200 }, (_, index) => `line ${String(index).padStart(3, '0')} ${'x'.repeat(100)}`).join('\n'));
	using view = new View({ container: requiredElement(dom.window.document, 'main'), model, minimap: { enabled: false } });
	const node = dom.window.document.createElement('div');
	let measurements = 0;
	node.getBoundingClientRect = () => {
		measurements++;
		return new dom.window.DOMRect(0, 0, 80, 20);
	};
	try {
		view.addOverlayWidget({
			getId: () => 'fixed-overlay',
			getDomNode: () => node,
			getPosition: () => ({ preference: OverlayWidgetPositionPreference.TOP_CENTER }),
		});
		view.layout({ width: 400, height: 100 });
		view.render(true, false);
		const initialPosition = { left: node.style.left, top: node.style.top };
		measurements = 0;
		for (const position of [{ left: 20, top: 20 }, { left: 60, top: 100 }, { left: 0, top: 200 }, { left: 0, top: 0 }]) {
			view.scrollTo(position);
			view.render(true, false);
			assert.deepEqual(view.viewportLayout.scrollPosition, position);
			assert.deepEqual({ left: node.style.left, top: node.style.top }, initialPosition);
		}
		assert.equal(measurements, 0, 'Document scrolling must not remeasure a viewport-fixed widget');
		view.layout({ width: 300, height: 100 });
		view.render(true, false);
		assert.equal(measurements, 1);
		assert.notEqual(node.style.left, initialPosition.left);
		view.changeViewZones(accessor => {
			accessor.addZone({ afterLineNumber: 1, heightInPx: 40, domNode: dom.window.document.createElement('div') });
		});
		view.render(true, false);
		assert.equal(measurements, 2, 'Non-scroll geometry changes still refresh all geometry consumers');
	} finally {
		view.dispose();
		dom.window.close();
	}
});

test('line-width measurement shares the layer scale and retains cached widths until content changes', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('first\nsecond\nthird');
	using view = new View({ container: requiredElement(dom.window.document, 'main'), model, minimap: { enabled: false }, disableMonospaceOptimizations: true });
	const prototype = dom.window.HTMLElement.prototype;
	const getBoundingClientRect = prototype.getBoundingClientRect;
	const offsetWidth = Object.getOwnPropertyDescriptor(prototype, 'offsetWidth')!;
	let scaleReads = 0;
	let textReads = 0;
	prototype.getBoundingClientRect = function () {
		if (this.classList.contains('view-lines')) {
			scaleReads++;
			return new dom.window.DOMRect(0, 0, 800, 200);
		}
		if (this.classList.contains('view-line')) {
			return new dom.window.DOMRect(0, 0, 800, 40);
		}
		if (this.classList.contains('stanza-editor-line-text')) {
			textReads++;
			return new dom.window.DOMRect(0, 0, 120, 40);
		}
		return getBoundingClientRect.call(this);
	};
	Object.defineProperty(prototype, 'offsetWidth', { configurable: true, get: () => 400 });
	try {
		view.layout({ width: 400, height: 300 });
		view.resetLineWidthCaches();
		view.render(true, false);
		assert.equal(scaleReads, 1);
		assert.equal(textReads, 3);
		for (let line = 1; line <= 3; line++) {
			assert.equal(view.getLineWidth(line), 60);
		}
		view.render(true, false);
		assert.equal(scaleReads, 1);
		assert.equal(textReads, 3);
		model.setValue('changed first\nchanged second\nchanged third');
		view.render(true, false);
		assert.equal(scaleReads, 2);
		assert.equal(textReads, 6);
		assert.equal(view.getLineWidth(1), 60);
	} finally {
		prototype.getBoundingClientRect = getBoundingClientRect;
		Object.defineProperty(prototype, 'offsetWidth', offsetWidth);
		view.dispose();
		dom.window.close();
	}
});

test('selective scroll rendering updates minimap slider and visible text without changing ruler geometry', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel(Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n'));
	using view = new View({ container: requiredElement(dom.window.document, 'main'), model, rulers: [40], minimap: { enabled: true, size: 'fit' } });
	try {
		view.layout({ width: 400, height: 100 });
		view.render(true, false);
		const slider = requiredElement<HTMLElement>(view.domNode.domNode, '.stanza-editor-minimap-slider');
		const ruler = requiredElement<HTMLElement>(view.domNode.domNode, '.stanza-editor-ruler');
		const first = requiredElement(view.domNode.domNode, '.stanza-editor-line-text').textContent;
		const initialTop = slider.style.top;
		const rulerHeight = ruler.style.height;
		assert.equal(slider.hidden, false);
		view.scrollTo({ left: 0, top: 200 });
		view.render(true, false);
		assert.ok(Number.parseFloat(slider.style.top) > Number.parseFloat(initialTop));
		assert.notEqual(requiredElement(view.domNode.domNode, '.stanza-editor-line-text').textContent, first);
		assert.equal(ruler.style.height, rulerHeight);
		view.scrollTo({ left: 0, top: 0 });
		view.render(true, false);
		assert.equal(slider.style.top, initialTop);
		assert.equal(requiredElement(view.domNode.domNode, '.stanza-editor-line-text').textContent, first);
		model.setValue('short document');
		view.render(true, false);
		assert.ok(Number.parseFloat(ruler.style.height) < Number.parseFloat(rulerHeight));
		assert.equal(slider.style.top, '0px');
	} finally {
		view.dispose();
		dom.window.close();
	}
});

test('one window frame renders all queued editors and later window frames do not repeat the batch', () => {
	const firstDom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
	const secondDom = new JSDOM('<!doctype html><body><main></main></body>', { pretendToBeVisual: true });
	const frames: FrameRequestCallback[][] = [[], []];
	const windows = [firstDom.window, secondDom.window];
	const requestFrames = windows.map(window => window.requestAnimationFrame);
	for (const [index, window] of windows.entries()) {
		window.HTMLCanvasElement.prototype.getContext = () => null;
		window.requestAnimationFrame = callback => frames[index]!.push(callback);
	}
	using firstModel = new TextModel('first');
	using secondModel = new TextModel('second');
	using first = new View({ container: requiredElement(firstDom.window.document, 'main'), model: firstModel, minimap: { enabled: false } });
	using second = new View({ container: requiredElement(secondDom.window.document, 'main'), model: secondModel, minimap: { enabled: false } });
	const measurements = [0, 0];
	try {
		for (const [index, view] of [first, second].entries()) {
			const node = view.domNode.domNode.ownerDocument.createElement('div');
			view.addContentWidget({
				getId: () => 'widget',
				getDomNode: () => node,
				getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
				beforeRender: () => { measurements[index]! += 1; return { width: 10, height: 10 }; },
			});
			view.layout({ width: 300, height: 100 });
		}
		frames[0]!.shift()!(0);
		assert.deepEqual(measurements, [1, 1]);
		frames[1]!.shift()!(0);
		assert.deepEqual(measurements, [1, 1]);

		first.layout({ width: 320, height: 100 });
		second.layout({ width: 320, height: 100 });
		first.dispose();
		frames[0]!.shift()!(0);
		assert.deepEqual(measurements, [1, 2]);
		frames[1]!.shift()!(0);
		assert.deepEqual(measurements, [1, 2]);

		second.layout({ width: 340, height: 100 });
		second.dispose();
		frames[1]!.shift()!(0);
		assert.deepEqual(measurements, [1, 2]);
	} finally {
		first.dispose();
		second.dispose();
		for (const [index, window] of windows.entries()) window.requestAnimationFrame = requestFrames[index]!;
		firstDom.window.close();
		secondDom.window.close();
	}
});


test("Stanza viewport automatic layout uses the observed content box", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	let resizeListener: ResizeObserverCallback | undefined;
	class TestResizeObserver {
		constructor(listener: ResizeObserverCallback) {
			resizeListener = listener;
		}

		observe(): void { }
		unobserve(): void { }
		disconnect(): void { }
	}
	Object.defineProperty(dom.window, "ResizeObserver", { configurable: true, value: TestResizeObserver });
	using installedObserver = installEditorTestGlobals({ ResizeObserver: TestResizeObserver });
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel();
	using viewport = new View({ container, model, lineHeight: 20, automaticLayout: true });
	Object.defineProperties(viewport.domNode.domNode, {
		clientWidth: { configurable: true, value: 383 },
		clientHeight: { configurable: true, value: 62 },
	});

	resizeListener?.([{ contentRect: { width: 383.3875, height: 46.7875 } } as ResizeObserverEntry], {} as ResizeObserver);
	viewport.render(true, false);

	assert.deepEqual(viewport.viewportLayout.viewportSize, { width: 383, height: 46 });
	assert.equal(viewport.domNode.domNode.style.width, "383px");
	assert.equal(viewport.domNode.domNode.style.height, "46px");
	assert.equal(viewport.domNode.domNode.classList.contains("horizontally-scrollable"), false);
	assert.equal(viewport.domNode.domNode.classList.contains("vertically-scrollable"), false);
	assert.equal(requiredElement<HTMLElement>(viewport.domNode.domNode, '[role="scrollbar"][aria-orientation="horizontal"]').hidden, true);
	assert.equal(requiredElement<HTMLElement>(viewport.domNode.domNode, '[role="scrollbar"][aria-orientation="vertical"]').hidden, true);
	assert.equal(requiredElement<HTMLElement>(viewport.domNode.domNode, ".stanza-editor-content").style.width, "383px");
	assert.equal(requiredElement<HTMLElement>(viewport.domNode.domNode, ".stanza-editor-content").style.height, "46px");
	dom.window.close();
});

test("Stanza viewport enables scrollbars only for model-backed overflow", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel(`${"x".repeat(100)}\nsecond line`);
	using viewport = new View({ container, model, lineHeight: 20 });

	viewport.layout({ width: 50, height: 20 });
	viewport.render(true, false);

	assert.equal(viewport.domNode.domNode.style.width, "50px");
	assert.equal(viewport.domNode.domNode.style.height, "20px");
	assert.equal(viewport.domNode.domNode.classList.contains("horizontally-scrollable"), true);
	assert.equal(viewport.domNode.domNode.classList.contains("vertically-scrollable"), true);
	const horizontalScrollbar = requiredElement<HTMLElement>(viewport.domNode.domNode, '[role="scrollbar"][aria-orientation="horizontal"]');
	const verticalScrollbar = requiredElement<HTMLElement>(viewport.domNode.domNode, '[role="scrollbar"][aria-orientation="vertical"]');
	assert.equal(horizontalScrollbar.hidden, false);
	assert.equal(verticalScrollbar.hidden, false);
	assert.equal(horizontalScrollbar.getAttribute("role"), "scrollbar");
	assert.equal(verticalScrollbar.getAttribute("aria-controls"), requiredElement<HTMLElement>(viewport.domNode.domNode, ".stanza-editor-content").id);
	assert.equal(horizontalScrollbar.style.height, "12px");
	assert.equal(verticalScrollbar.style.width, "14px");
	assert.equal(horizontalScrollbar.style.right, "14px");
	assert.equal(verticalScrollbar.style.bottom, "12px");
	dom.window.close();
});

test("Stanza viewport applies recomputed font configuration", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("text");
	const viewport = new View({ container, model, lineHeight: 20, minimap: { enabled: false } });
	try {
		EditorZoom.setZoomLevel(1);
		assert.equal(viewport.fontInfo.lineHeight, 22);
		assert.equal(viewport.currentLayout.lineHeight, 22);
		assert.equal(viewport.domNode.domNode.style.lineHeight, "22px");
	} finally {
		viewport.dispose();
		EditorZoom.setZoomLevel(0);
		dom.window.close();
	}
});

test('rendered widths update scroll layout before widget measurements and shrink after hint removal', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const idleTasks = new Map<number, IdleRequestCallback>();
	let idleHandle = 0;
	Object.assign(dom.window, {
		requestIdleCallback: (callback: IdleRequestCallback) => {
			idleTasks.set(++idleHandle, callback);
			return idleHandle;
		},
		cancelIdleCallback: (handle: number) => { idleTasks.delete(handle); },
	});
	using model = new TextModel([...Array<string>(599).fill('abc'), 'x'.repeat(20)].join('\n'));
	using view = new View({ container: requiredElement(dom.window.document, 'main'), model, minimap: { enabled: false } });
	try {
		view.layout({ width: 300, height: 80 });
		view.render(true, false);
		const text = requiredElement<HTMLElement>(view.domNode.domNode, '.stanza-editor-line-text');
		text.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, model.getAllDecorations().length > 0 ? 900 : 24, 20);
		let measuredScrollRange = 0;
		view.addContentWidget({
			getId: () => 'width-observer',
			getDomNode: () => dom.window.document.createElement('div'),
			getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
			beforeRender: () => { measuredScrollRange = view.viewportLayout.maximumScrollPosition.left; return { width: 10, height: 10 }; },
		});
		const decorations = model.deltaDecorations([], [{ range: new Range(1, 4, 1, 4), options: { description: 'wide hint', after: { content: 'hint'.repeat(100) } } }]);
		view.render(true, false);
		const content = requiredElement<HTMLElement>(view.domNode.domNode, '.stanza-editor-content');
		assert.ok(measuredScrollRange >= 600);
		assert.equal(content.style.width, `${view.viewportLayout.contentSize.width}px`);
		assert.ok(idleTasks.size > 0);
		for (const [handle, callback] of idleTasks) {
			idleTasks.delete(handle);
			callback({ didTimeout: false, timeRemaining: () => 50 });
		}
		view.render(true, false);
		assert.ok(view.viewportLayout.maximumScrollPosition.left >= 600, 'Idle estimates must retain rendered hint widths');
		view.scrollTo({ left: 500, top: 0 });
		assert.equal(view.viewportLayout.scrollPosition.left, 500);
		model.deltaDecorations(decorations, []);
		view.render(true, false);
		assert.deepEqual({ width: view.viewportLayout.contentSize.width, scrollLeft: view.viewportLayout.scrollPosition.left }, { width: 300, scrollLeft: 0 });
		view.resetLineWidthCaches();
		assert.ok(idleTasks.size > 0);
		view.dispose();
		assert.equal(idleTasks.size, 0, 'Disposing the text layer cancels its pending width estimates');
	} finally {
		view.dispose();
		dom.window.close();
	}
});

test('glyph lanes reuse scans for cursor movement and resize and track margin changes', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('first\nsecond\nthird');
	using view = new View({ container: requiredElement(dom.window.document, 'main'), model, glyphMargin: true, minimap: { enabled: false } });
	const original = model.getAllMarginDecorations;
	let scans = 0;
	model.getAllMarginDecorations = (...args) => { scans++; return original.apply(model, args); };
	try {
		for (let index = 1; index <= 3; index++) {
			view.controller.setSelection(new Selection(index, 1, index, 1));
			view.layout({ width: 300 + index, height: 80 });
			view.render(true, false);
		}
		model.deltaDecorations([], [{ range: new Range(1, 1, 1, 2), options: { description: 'inline only', className: 'inline-only' } }]);
		view.render(true, false);
		assert.equal(scans, 0);
		const margin = model.deltaDecorations([], [{ range: new Range(2, 1, 2, 1), options: { description: 'glyph', glyphMarginClassName: 'audit-glyph', glyphMargin: { position: GlyphMarginLane.Right } } }]);
		view.render(true, false);
		assert.equal(scans, 1);
		model.applyEdits([{ range: new Range(1, 1, 1, 1), text: 'new line\n' }]);
		view.render(true, false);
		assert.equal(view.testViewModel.glyphLanes.getLanesAtLine(3).includes(GlyphMarginLane.Right), true);
		model.deltaDecorations(margin, []);
		view.render(true, false);
		assert.equal(scans, 3);
		let lane = GlyphMarginLane.Right;
		const widget = { getId: () => 'glyph-widget', getDomNode: () => dom.window.document.createElement('div'), getPosition: () => ({ range: new Range(1, 1, 1, 1), lane, zIndex: 0 }) };
		view.addGlyphMarginWidget(widget);
		view.render(true, false);
		lane = GlyphMarginLane.Left;
		view.layoutGlyphMarginWidget(widget);
		view.render(true, false);
		view.removeGlyphMarginWidget(widget);
		view.render(true, false);
		assert.equal(scans, 6);
	} finally {
		model.getAllMarginDecorations = original;
		view.dispose();
		dom.window.close();
	}
});

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}
